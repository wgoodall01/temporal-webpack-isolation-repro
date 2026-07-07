import { workflowInfo } from "@temporalio/workflow";

/**
 * Module-level mutable state.
 *
 * Per the Temporal TS SDK's sandbox model, each workflow execution gets its
 * own instance of the workflow module graph, so this variable should be
 * `undefined` at the start of EVERY workflow execution.
 */
let moduleState: string | undefined;

/**
 * Records this workflow's ID in module-level state, and reports whatever was
 * already there. If module isolation works, `leakedFrom` is always null.
 */
export async function stateProbe(): Promise<{ leakedFrom: string | null }> {
  const { workflowId } = workflowInfo();
  if (moduleState === undefined) {
    moduleState = workflowId;
    return { leakedFrom: null };
  }
  return { leakedFrom: moduleState };
}
