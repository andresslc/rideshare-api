const ELEVEN_HOURS_MIN = 11 * 60;
const TWELVE_HOURS_MIN = 12 * 60;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const SHIFT_LIMIT_ACTION = Object.freeze({
  CONTINUE: "continue",
  DEFER_OFFLINE: "defer_offline",
  FORCE_OFFLINE: "force_offline",
});

function getShiftLimitAction(totalMinutes, hasActiveAssignment) {
  if (totalMinutes < TWELVE_HOURS_MIN) {
    return SHIFT_LIMIT_ACTION.CONTINUE;
  }

  return hasActiveAssignment
    ? SHIFT_LIMIT_ACTION.DEFER_OFFLINE
    : SHIFT_LIMIT_ACTION.FORCE_OFFLINE;
}

function getBreakEndTimestamp(breakStartedAt) {
  if (!breakStartedAt) return null;

  const breakStartTimestamp = new Date(breakStartedAt).getTime();
  if (Number.isNaN(breakStartTimestamp)) return null;

  return breakStartTimestamp + SIX_HOURS_MS;
}

module.exports = {
  ELEVEN_HOURS_MIN,
  TWELVE_HOURS_MIN,
  SHIFT_LIMIT_ACTION,
  getShiftLimitAction,
  getBreakEndTimestamp,
};
