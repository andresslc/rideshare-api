const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getBreakEndTimestamp,
} = require("../src/feature/driver/driver-shift.policy");

test("calculates the break deadline from the break start time", () => {
  const breakStartedAt = new Date("2026-09-11T00:00:00.000Z");

  assert.equal(
    getBreakEndTimestamp(breakStartedAt),
    new Date("2026-09-11T06:00:00.000Z").getTime(),
  );
});

test("returns null when the break start time is unavailable or invalid", () => {
  assert.equal(getBreakEndTimestamp(null), null);
  assert.equal(getBreakEndTimestamp("not-a-date"), null);
});
