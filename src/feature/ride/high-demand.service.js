const https = require('https');
const { getRedisConnection } = require('../../core/services/redis/redis.service');
const { sendNotificationToSpecificUser } = require('../notification/notification.service');
const { REDIS_CONSTANTS } = require('../../core/common/constants/redis-constants');
const { t } = require('../../core/common/helpers');
const DriverModel = require('../driver/models/driver.model');
const {
  HOTSPOT_PASSENGER_THRESHOLD,
  CLUSTER_RADIUS_KM,
  PASSENGER_PRESENCE_WINDOW_SECONDS,
  PASSENGER_PRESENCE_TTL_SECONDS,
  DRIVER_NOTIFY_RADIUS_KM,
  DRIVER_COOLDOWN_SECONDS,
  CRON_LOCK_KEY,
  CRON_LOCK_TTL_SECONDS,
  PASSENGER_PRESENCE_KEY_PREFIX,
  DRIVER_COOLDOWN_KEY_PREFIX,
} = require('./high-demand-constants');

const TAG = '[HIGH-DEMAND]';

/* ─────────────────────────────────────────────────────────────
   Haversine distance (km) between two lat/lng points
   ───────────────────────────────────────────────────────────── */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ─────────────────────────────────────────────────────────────
   Minimal promise wrapper around Node's built-in https.get
   ───────────────────────────────────────────────────────────── */
function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const options = { headers };
    https
      .get(url, options, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            reject(new Error('JSON parse error'));
          }
        });
      })
      .on('error', reject);
  });
}

/* ─────────────────────────────────────────────────────────────
   trackPassengerPresence
   Called on socket connect for passengers (role === "user").
   ───────────────────────────────────────────────────────────── */
async function trackPassengerPresence(userId, lat, lng) {
  const redis = getRedisConnection();
  const key = `${PASSENGER_PRESENCE_KEY_PREFIX}:${userId}`;
  const hasCoords = lat != null && lng != null;
  const payload = JSON.stringify({ userId, lat, lng, connectedAt: Date.now() });

  console.log(
    `${TAG} [TRACK] User connected — userId=${userId} lat=${lat} lng=${lng} hasCoords=${hasCoords}`,
  );

  await redis.set(key, payload, 'EX', PASSENGER_PRESENCE_TTL_SECONDS);
  console.log(
    `${TAG} [TRACK] Presence key written → "${key}" (TTL: ${PASSENGER_PRESENCE_TTL_SECONDS}s)`,
  );

  // Keep the geo index fresh if coordinates are available
  if (hasCoords) {
    await redis.geoadd(REDIS_CONSTANTS.USER_GEO_KEY, lng, lat, userId);
    console.log(
      `${TAG} [TRACK] GEOADD → users:geo updated for userId=${userId} at (${lat}, ${lng})`,
    );
  } else {
    console.log(
      `${TAG} [TRACK] No coordinates — presence key stored but geo index skipped for userId=${userId}`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────
   removePassengerPresence
   Called on socket disconnect, ride start, or carpool acceptance.
   ───────────────────────────────────────────────────────────── */
async function removePassengerPresence(userId) {
  const redis = getRedisConnection();
  const key = `${PASSENGER_PRESENCE_KEY_PREFIX}:${userId}`;

  console.log(`${TAG} [REMOVE] Removing presence for userId=${userId} key="${key}"`);

  const deleted = await redis.del(key);
  if (deleted) {
    console.log(`${TAG} [REMOVE] ✅ Presence key deleted for userId=${userId}`);
  } else {
    console.log(`${TAG} [REMOVE] ⚠️  Key did not exist (already removed or never set) for userId=${userId}`);
  }
}

/* ─────────────────────────────────────────────────────────────
   runHighDemandCheck — main cron body
   ───────────────────────────────────────────────────────────── */
async function runHighDemandCheck(io) {
  const redis = getRedisConnection();
  const runAt = new Date().toISOString();

  console.log(`\n${TAG} ════════════════════════════════════════`);
  console.log(`${TAG} Cron run started at ${runAt}`);
  console.log(`${TAG} ════════════════════════════════════════`);

  // ── Step 1: Distributed lock ─────────────────────────────────
  console.log(`${TAG} [LOCK] Attempting to acquire lock "${CRON_LOCK_KEY}" (TTL: ${CRON_LOCK_TTL_SECONDS}s)...`);
  const lockAcquired = await redis.set(CRON_LOCK_KEY, '1', 'NX', 'EX', CRON_LOCK_TTL_SECONDS);

  if (!lockAcquired) {
    console.log(`${TAG} [LOCK] ⚠️  Lock already held by another process — skipping this run.`);
    return;
  }
  console.log(`${TAG} [LOCK] ✅ Lock acquired.`);

  try {
    // ── Step 2: SCAN for active passengers ───────────────────────
    console.log(`\n${TAG} [SCAN] Scanning Redis for pattern "${PASSENGER_PRESENCE_KEY_PREFIX}:*" ...`);

    const activePassengers = [];
    const now = Date.now();
    const windowMs = PASSENGER_PRESENCE_WINDOW_SECONDS * 1000;
    const pattern = `${PASSENGER_PRESENCE_KEY_PREFIX}:*`;

    let cursor = '0';
    let scanBatch = 0;
    let totalKeysScanned = 0;
    let skippedNoCoords = 0;
    let skippedExpired = 0;
    let skippedMalformed = 0;

    do {
      scanBatch++;
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      totalKeysScanned += keys.length;

      console.log(
        `${TAG} [SCAN] Batch #${scanBatch} → cursor=${nextCursor} keys_in_batch=${keys.length} total_scanned=${totalKeysScanned}`,
      );

      if (keys.length > 0) {
        // Pipeline GET calls for efficiency
        const pipeline = redis.pipeline();
        keys.forEach((k) => pipeline.get(k));
        const results = await pipeline.exec();

        results.forEach(([err, value], idx) => {
          if (err) {
            console.error(`${TAG} [SCAN] Pipeline GET error for key "${keys[idx]}":`, err.message);
            return;
          }
          if (!value) {
            console.log(`${TAG} [SCAN] Key "${keys[idx]}" returned null (expired between SCAN and GET) — skipped.`);
            return;
          }

          try {
            const entry = JSON.parse(value);
            const ageMs = now - entry.connectedAt;
            const ageSec = Math.round(ageMs / 1000);

            if (typeof entry.lat !== 'number' || typeof entry.lng !== 'number') {
              console.log(
                `${TAG} [SCAN] userId=${entry.userId} — no coordinates stored, skipped for clustering.`,
              );
              skippedNoCoords++;
              return;
            }

            if (entry.connectedAt < now - windowMs) {
              console.log(
                `${TAG} [SCAN] userId=${entry.userId} — presence is ${ageSec}s old (>${PASSENGER_PRESENCE_WINDOW_SECONDS}s window), skipped.`,
              );
              skippedExpired++;
              return;
            }

            console.log(
              `${TAG} [SCAN] ✅ userId=${entry.userId} lat=${entry.lat} lng=${entry.lng} age=${ageSec}s — added to pool.`,
            );
            activePassengers.push({ userId: entry.userId, lat: entry.lat, lng: entry.lng });
          } catch (_) {
            console.error(`${TAG} [SCAN] Malformed JSON for key "${keys[idx]}" — skipped.`);
            skippedMalformed++;
          }
        });
      }
    } while (cursor !== '0');

    console.log(`\n${TAG} [SCAN] ── Scan Summary ──────────────────────────`);
    console.log(`${TAG} [SCAN]   Total keys scanned  : ${totalKeysScanned}`);
    console.log(`${TAG} [SCAN]   Valid with coords   : ${activePassengers.length}`);
    console.log(`${TAG} [SCAN]   Skipped (no coords) : ${skippedNoCoords}`);
    console.log(`${TAG} [SCAN]   Skipped (expired)   : ${skippedExpired}`);
    console.log(`${TAG} [SCAN]   Skipped (malformed) : ${skippedMalformed}`);
    console.log(`${TAG} [SCAN] ──────────────────────────────────────────────\n`);

    if (activePassengers.length < HOTSPOT_PASSENGER_THRESHOLD) {
      console.log(
        `${TAG} [CLUSTER] Only ${activePassengers.length} passenger(s) with coords — need at least ${HOTSPOT_PASSENGER_THRESHOLD} to form a hotspot. Exiting early.`,
      );
      return;
    }

    // ── Step 3: Greedy spatial clustering ─────────────────────────
    console.log(`${TAG} [CLUSTER] Starting greedy clustering (radius=${CLUSTER_RADIUS_KM}km, threshold=${HOTSPOT_PASSENGER_THRESHOLD})...`);

    const processed = new Set();
    const hotspots = [];

    for (let i = 0; i < activePassengers.length; i++) {
      if (processed.has(i)) continue;

      const seed = activePassengers[i];
      const group = [i];

      for (let j = i + 1; j < activePassengers.length; j++) {
        if (processed.has(j)) continue;
        const candidate = activePassengers[j];
        const dist = haversineKm(seed.lat, seed.lng, candidate.lat, candidate.lng);
        if (dist <= CLUSTER_RADIUS_KM) {
          group.push(j);
        }
      }

      if (group.length >= HOTSPOT_PASSENGER_THRESHOLD) {
        const members = group.map((idx) => activePassengers[idx]);
        const centroidLat = members.reduce((s, p) => s + p.lat, 0) / members.length;
        const centroidLng = members.reduce((s, p) => s + p.lng, 0) / members.length;
        hotspots.push({ lat: centroidLat, lng: centroidLng, count: members.length });
        group.forEach((idx) => processed.add(idx));

        console.log(
          `${TAG} [CLUSTER] ✅ Hotspot #${hotspots.length} — ${members.length} passengers, centroid=(${centroidLat.toFixed(5)}, ${centroidLng.toFixed(5)})`,
        );
      } else {
        console.log(
          `${TAG} [CLUSTER] Seed userId=${seed.userId} — group size ${group.length} < ${HOTSPOT_PASSENGER_THRESHOLD}, not a hotspot.`,
        );
      }
    }

    console.log(`\n${TAG} [CLUSTER] ── Cluster Summary ──────────────────────`);
    console.log(`${TAG} [CLUSTER]   Passengers evaluated : ${activePassengers.length}`);
    console.log(`${TAG} [CLUSTER]   Hotspots found       : ${hotspots.length}`);
    console.log(`${TAG} [CLUSTER] ──────────────────────────────────────────────\n`);

    if (hotspots.length === 0) {
      console.log(`${TAG} [CLUSTER] No qualifying hotspots. Exiting.`);
      return;
    }

    // ── Step 4: Process each hotspot ──────────────────────────────
    for (let hi = 0; hi < hotspots.length; hi++) {
      const centroid = hotspots[hi];
      console.log(`\n${TAG} ── Processing Hotspot ${hi + 1}/${hotspots.length} ──────────────`);
      console.log(`${TAG} [HOTSPOT] Passengers in cluster : ${centroid.count}`);
      console.log(`${TAG} [HOTSPOT] Centroid              : lat=${centroid.lat.toFixed(5)}, lng=${centroid.lng.toFixed(5)}`);

      // ── 4a: Reverse geocode ──────────────────────────────────────
      let areaName = `${centroid.lat.toFixed(4)}, ${centroid.lng.toFixed(4)}`;
      const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${centroid.lat}&lon=${centroid.lng}&format=json`;

      console.log(`${TAG} [GEO] Calling Nominatim: ${nominatimUrl}`);
      try {
        const geo = await httpsGetJson(nominatimUrl, { 'User-Agent': 'RideShare-API' });
        const addr = geo?.address || {};
        console.log(`${TAG} [GEO] Raw address fields: suburb="${addr.suburb}" neighbourhood="${addr.neighbourhood}" city_district="${addr.city_district}" town="${addr.town}" city="${addr.city}"`);

        const label =
          addr.suburb ||
          addr.neighbourhood ||
          addr.city_district ||
          addr.town ||
          addr.city;

        if (label) {
          areaName = label;
          console.log(`${TAG} [GEO] ✅ Resolved area name: "${areaName}"`);
        } else {
          console.log(`${TAG} [GEO] ⚠️  No usable label in address — falling back to coordinates: "${areaName}"`);
        }
      } catch (geoErr) {
        console.error(`${TAG} [GEO] ❌ Nominatim call failed: ${geoErr?.message} — using coordinate fallback "${areaName}"`);
      }

      // ── 4b: GEORADIUS for nearby drivers ────────────────────────
      console.log(
        `${TAG} [DRIVERS] GEORADIUS drivers:geo around (${centroid.lng.toFixed(5)}, ${centroid.lat.toFixed(5)}) within ${DRIVER_NOTIFY_RADIUS_KM}km...`,
      );

      let driverEntries = [];
      try {
        driverEntries = await redis.georadius(
          REDIS_CONSTANTS.DRIVER_GEO_KEY,
          centroid.lng,
          centroid.lat,
          DRIVER_NOTIFY_RADIUS_KM,
          'km',
          'WITHCOORD',
        );
        console.log(`${TAG} [DRIVERS] GEORADIUS returned ${driverEntries.length} driver(s).`);
      } catch (geoRadiusErr) {
        console.error(`${TAG} [DRIVERS] ❌ GEORADIUS error: ${geoRadiusErr?.message}`);
      }

      if (!driverEntries || driverEntries.length === 0) {
        console.log(`${TAG} [DRIVERS] No drivers found within ${DRIVER_NOTIFY_RADIUS_KM}km — skipping hotspot.`);
        continue;
      }

      // ── 4c: Eligibility checks per driver ───────────────────────
      console.log(`${TAG} [FILTER] Running eligibility checks on ${driverEntries.length} driver(s)...`);

      const eligibleDriverIds = [];
      let rejectedOffline = 0;
      let rejectedActiveRide = 0;
      let rejectedActiveCarpool = 0;
      let rejectedCooldown = 0;

      for (const entry of driverEntries) {
        const driverId = Array.isArray(entry) ? entry[0] : entry;
        console.log(`${TAG} [FILTER] Checking driverId=${driverId}...`);

        // Check 1: online status
        const status = await redis.hget(REDIS_CONSTANTS.keys.driverHash(driverId), 'status');
        if (status !== 'online') {
          console.log(`${TAG} [FILTER]   ✗ driverId=${driverId} status="${status}" (not online) — skipped.`);
          rejectedOffline++;
          continue;
        }
        console.log(`${TAG} [FILTER]   ✓ driverId=${driverId} status=online`);

        // Check 2: no active ride
        const hasRide = await redis.exists(REDIS_CONSTANTS.keys.driverActive(driverId));
        if (hasRide) {
          console.log(`${TAG} [FILTER]   ✗ driverId=${driverId} has an active ride — skipped.`);
          rejectedActiveRide++;
          continue;
        }
        console.log(`${TAG} [FILTER]   ✓ driverId=${driverId} no active ride`);

        // Check 3: no active carpool
        const hasCarpool = await redis.exists(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId));
        if (hasCarpool) {
          console.log(`${TAG} [FILTER]   ✗ driverId=${driverId} has an active carpool — skipped.`);
          rejectedActiveCarpool++;
          continue;
        }
        console.log(`${TAG} [FILTER]   ✓ driverId=${driverId} no active carpool`);

        // Check 4: cooldown
        const cooldownKey = `${DRIVER_COOLDOWN_KEY_PREFIX}:${driverId}`;
        const onCooldown = await redis.exists(cooldownKey);
        if (onCooldown) {
          const ttl = await redis.ttl(cooldownKey);
          console.log(`${TAG} [FILTER]   ✗ driverId=${driverId} on cooldown (${ttl}s remaining) — skipped.`);
          rejectedCooldown++;
          continue;
        }
        console.log(`${TAG} [FILTER]   ✓ driverId=${driverId} not on cooldown`);

        console.log(`${TAG} [FILTER]   ✅ driverId=${driverId} is eligible.`);
        eligibleDriverIds.push(driverId);
      }

      console.log(`\n${TAG} [FILTER] ── Filter Summary ───────────────────────`);
      console.log(`${TAG} [FILTER]   Total checked          : ${driverEntries.length}`);
      console.log(`${TAG} [FILTER]   Eligible               : ${eligibleDriverIds.length}`);
      console.log(`${TAG} [FILTER]   Rejected (offline)     : ${rejectedOffline}`);
      console.log(`${TAG} [FILTER]   Rejected (active ride) : ${rejectedActiveRide}`);
      console.log(`${TAG} [FILTER]   Rejected (carpool)     : ${rejectedActiveCarpool}`);
      console.log(`${TAG} [FILTER]   Rejected (cooldown)    : ${rejectedCooldown}`);
      console.log(`${TAG} [FILTER] ─────────────────────────────────────────────\n`);

      if (eligibleDriverIds.length === 0) {
        console.log(`${TAG} [FILTER] No eligible drivers for this hotspot — skipping.`);
        continue;
      }

      // ── 4d: Set cooldown ─────────────────────────────────────────
      console.log(`${TAG} [COOLDOWN] Setting ${DRIVER_COOLDOWN_SECONDS}s cooldown for ${eligibleDriverIds.length} driver(s): [${eligibleDriverIds.join(', ')}]`);
      const cooldownPipeline = redis.pipeline();
      eligibleDriverIds.forEach((driverId) => {
        cooldownPipeline.set(
          `${DRIVER_COOLDOWN_KEY_PREFIX}:${driverId}`,
          '1',
          'EX',
          DRIVER_COOLDOWN_SECONDS,
        );
      });
      await cooldownPipeline.exec();
      console.log(`${TAG} [COOLDOWN] ✅ Cooldown keys set.`);

      // ── 4e: Send notification ────────────────────────────────────
      const drivers = await DriverModel.find({
        _id: { $in: eligibleDriverIds },
      }).select('_id locale');
      const driverIdsByLocale = drivers.reduce((groups, driver) => {
        const locale = driver.locale || 'en';
        if (!groups[locale]) groups[locale] = [];
        groups[locale].push(driver._id);
        return groups;
      }, {});
      console.log(`${TAG} [NOTIFY] Sending notification to ${eligibleDriverIds.length} driver(s):`);
      console.log(`${TAG} [NOTIFY]   locales     : [${Object.keys(driverIdsByLocale).join(', ')}]`);
      console.log(`${TAG} [NOTIFY]   metadata    : type=high_demand lat=${centroid.lat} lng=${centroid.lng}`);
      console.log(`${TAG} [NOTIFY]   userIds     : [${eligibleDriverIds.join(', ')}]`);

      await Promise.all(
        Object.entries(driverIdsByLocale).map(([locale, localizedIds]) =>
          sendNotificationToSpecificUser({
            title: t('HIGH_DEMAND_TITLE', locale),
            description: t('HIGH_DEMAND_DESC', locale).replace(
              '${area}',
              areaName,
            ),
            metadata: {
              type: 'high_demand',
              lat: centroid.lat,
              lng: centroid.lng,
            },
            userIds: localizedIds,
            skipSave: false,
          }),
        ),
      );

      console.log(
        `${TAG} [NOTIFY] ✅ Notification dispatched — hotspot="${areaName}" drivers_notified=${eligibleDriverIds.length}`,
      );
    }

    console.log(`\n${TAG} [DONE] All hotspots processed.`);

  } catch (err) {
    console.error(`${TAG} ❌ Unhandled error in runHighDemandCheck:`, err?.message, err?.stack);
  } finally {
    // ── Step 5: Release lock ─────────────────────────────────────
    await redis.del(CRON_LOCK_KEY);
    console.log(`${TAG} [LOCK] 🔓 Lock released.`);
    console.log(`${TAG} ════════════════════════════════════════\n`);
  }
}

module.exports = {
  trackPassengerPresence,
  removePassengerPresence,
  runHighDemandCheck,
};
