import type { Operations } from "@mingchuno/agent-workflows";

/** Ordinary TypeScript composition; provider adapters remain unchanged. */
export async function reportingWorkflow(operations: Operations): Promise<void> {
  if (!(await operations.eligible())) {
    await operations.step("ineligible", async (run) => {
      await operations.dependencies.store.patchRun(run.id, {
        outcome: "ineligible",
      });
    });
    return;
  }
  await operations.prepare();
  await operations.implement();
  if (!(await operations.validate())) {
    await operations.complete("no-change");
    return;
  }
  await operations.step("validation-report", async (run) => {
    await operations.dependencies.store.emit(run.id, "validation-report", {
      checks: run.validation ?? [],
      changedPaths: run.snapshot?.paths ?? [],
    });
  });
  await operations.writePublication();
  await operations.commit();
  await operations.push();
  await operations.publish();
  await operations.review();
  await operations.publishReview();
  await operations.complete();
}
