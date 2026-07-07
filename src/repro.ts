/**
 * Repro for: Temporal TS SDK per-workflow module isolation silently disabled
 * when webpack emits `const __webpack_module_cache__` in its runtime.
 *
 * Runs two workflow executions, one after the other, on a single-threaded
 * worker (reuseV8Context enabled — the default). Each workflow writes its own
 * workflow ID into a module-level variable and reports what it found there.
 *
 * Expected (isolation intact): both executions find `undefined`.
 * Actual (bug): the second execution observes the first execution's state.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  Worker,
  bundleWorkflowCode,
  Runtime,
  DefaultLogger,
} from "@temporalio/worker";
import type { stateProbe } from "./workflows";

// Keep worker lifecycle noise out of the repro output.
Runtime.install({ logger: new DefaultLogger("ERROR") });

const require = createRequire(import.meta.url);
const workflowsPath = path.join(import.meta.dirname, "workflows.ts");

async function main(env) {
  // Resolve the webpack version the SDK's bundler will actually use.
  const webpackPkg = require.resolve("webpack/package.json", {
    paths: [require.resolve("@temporalio/worker")],
  });
  const webpackVersion: string = require(webpackPkg).version;

  // Mechanism check: did the SDK's module-cache rewrite apply to the bundle?
  // bundler.ts does an exact-match string replacement of
  //   'var __webpack_module_cache__ = {}'
  // which silently no-ops when webpack emits `const` instead of `var`.
  const { code } = await bundleWorkflowCode({ workflowsPath });
  const cacheDecls =
    code.match(/(?:var|const|let) __webpack_module_cache__ = [^\n;]*/g) ?? [];
  const rewriteApplied = code.includes(
    "__webpack_module_cache__ = globalThis.__webpack_module_cache__",
  );

  console.log(`webpack version:         ${webpackVersion}`);
  console.log(`module cache in bundle:  ${JSON.stringify(cacheDecls)}`);
  console.log(`SDK cache rewrite applied: ${rewriteApplied}\n`);

  // Behavioral check: run two workflows on one worker thread and see whether
  // module-level state leaks from the first execution into the second.
  const taskQueue = "isolation-repro";
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: { code },

    // One workflow thread so both executions definitely share a thread.
    workflowThreadPoolSize: 1,

    // reuseV8Context defaults to true; stated explicitly for clarity.
    reuseV8Context: true,
  });

  // Run two state-probe workflows, one after the other.
  const [first, second] = await worker.runUntil(async () => {
    const first = await env.client.workflow.execute<typeof stateProbe>(
      "stateProbe",
      { workflowId: "probe-1", taskQueue },
    );
    const second = await env.client.workflow.execute<typeof stateProbe>(
      "stateProbe",
      { workflowId: "probe-2", taskQueue },
    );
    return [first, second];
  });

  // Log the observed moduleState values.
  console.log(`probe-1 observed moduleState: ${first.leakedFrom}`);
  console.log(`probe-2 observed moduleState: ${second.leakedFrom}`);
  console.log();

  if (second.leakedFrom !== null) {
    console.log(
      "❌ ISOLATION BROKEN: workflow probe-2 observed module-level state " +
        `written by workflow ${second.leakedFrom}.` +
        "\n   (The SDK's __webpack_module_cache__ rewrite did not apply, so all" +
        "\n   workflows on this worker thread share one webpack module cache.)",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "✅ Isolation intact: no module-level state leaked between executions.",
    );
  }
}

const env = await TestWorkflowEnvironment.createLocal();
try {
  await main(env);
} finally {
  await env.teardown();
}
