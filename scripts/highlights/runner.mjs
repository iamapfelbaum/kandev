export const PIPELINE_ORDER = Object.freeze(["validate", "storyboard", "capture", "render", "qa", "stage"]);

export async function runHighlightPipeline({ scenario, adapters, dryRun = false, context = {} } = {}) {
  if (!scenario || typeof scenario !== "object") throw new Error("pipeline scenario is required");
  if (!adapters || typeof adapters !== "object") throw new Error("pipeline adapters are required");
  const phases = {};
  const completed = [];
  for (const phase of PIPELINE_ORDER) {
    const adapter = adapters[phase];
    if (typeof adapter !== "function") throw new Error(`pipeline adapter '${phase}' is required`);
    try {
      phases[phase] = await adapter({
        scenario,
        dryRun,
        context,
        phases: { ...phases },
        previous: completed.length ? phases[completed.at(-1)] : null,
      });
      if (phase === "qa" && phases.qa?.passed === false) {
        throw new Error("QA report did not pass");
      }
      completed.push(phase);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(`Highlight pipeline ${phase} failed: ${message}`, { cause });
      error.phase = phase;
      error.completed = [...completed];
      error.phases = { ...phases };
      throw error;
    }
  }
  return {
    contract: "kandev-highlight-pipeline-v1",
    scenarioId: scenario.id ?? null,
    dryRun,
    passed: phases.qa?.passed !== false,
    order: [...PIPELINE_ORDER],
    phases,
  };
}
