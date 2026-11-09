module.exports = {
  // Passengers needed inside a cluster to qualify as a hotspot
  HOTSPOT_PASSENGER_THRESHOLD: 10,

  // Radius used when grouping passengers into clusters (km)
  CLUSTER_RADIUS_KM: 1,

  // A passenger presence entry is only valid if their socket connected
  // within this window (seconds). Must match the Redis TTL below.
  PASSENGER_PRESENCE_WINDOW_SECONDS: 10 * 60, // 10 minutes

  // Redis TTL applied to every passenger presence key (must equal window above)
  PASSENGER_PRESENCE_TTL_SECONDS: 10 * 60,

  // Drivers within this radius of the hotspot centroid get notified (km)
  DRIVER_NOTIFY_RADIUS_KM: 5,

  // A driver will not receive another high-demand notification for this long (seconds)
  DRIVER_COOLDOWN_SECONDS: 15 * 60, // 15 minutes

  // How often the cron runs
  CRON_SCHEDULE: '*/2 * * * *', // every 2 minutes

  // Redis key for the cron distributed lock
  CRON_LOCK_KEY: 'cron:high-demand:lock',

  // Lock TTL — slightly longer than cron interval so a stale lock auto-expires
  CRON_LOCK_TTL_SECONDS: 90,

  // Prefix for passenger presence keys: `presence:passenger:<userId>`
  PASSENGER_PRESENCE_KEY_PREFIX: 'presence:passenger',

  // Prefix for per-driver cooldown keys: `high-demand:cooldown:driver:<driverId>`
  DRIVER_COOLDOWN_KEY_PREFIX: 'high-demand:cooldown:driver',

  // Notification copy
  NOTIFICATION_TITLE: 'High Demand Nearby',
  NOTIFICATION_BODY_TEMPLATE: 'Many riders near {{area}}',
};
