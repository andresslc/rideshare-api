const { randomUUID } = require("node:crypto");

const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");

const RELEASE_IF_OWNED_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function acquireAssignmentLock(
  redis,
  driverId,
  { ttlSeconds = 60, waitMilliseconds = 2000, retryMilliseconds = 25 } = {},
) {
  const key = REDIS_CONSTANTS.keys.driverAssignmentLock(String(driverId));
  const owner = randomUUID();
  const deadline = Date.now() + waitMilliseconds;

  do {
    const acquired = await redis.set(
      key,
      owner,
      REDIS_CONSTANTS.NX,
      REDIS_CONSTANTS.EX,
      ttlSeconds,
    );

    if (acquired) return { key, owner };
    if (Date.now() >= deadline) return null;
    await wait(retryMilliseconds);
  } while (true);
}

async function releaseAssignmentLock(redis, lock) {
  if (!lock) return;
  try {
    await redis.eval(RELEASE_IF_OWNED_SCRIPT, 1, lock.key, lock.owner);
  } catch (error) {
    // The lock has a TTL, so a transient cleanup failure must not turn an
    // already committed assignment/cancellation into an API failure.
    console.error("Failed to release assignment lock", {
      key: lock.key,
      error: error.message,
    });
  }
}

module.exports = {
  acquireAssignmentLock,
  releaseAssignmentLock,
};
