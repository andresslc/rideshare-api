async function measureAsync(operation, context, task) {
  const startedAt = process.hrtime.bigint();
  let outcome = "success";

  try {
    return await task();
  } catch (error) {
    outcome = "failure";
    throw error;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.info(
      JSON.stringify({
        type: "performance",
        operation,
        outcome,
        durationMs: Number(durationMs.toFixed(2)),
        ...context,
      }),
    );
  }
}

module.exports = { measureAsync };
