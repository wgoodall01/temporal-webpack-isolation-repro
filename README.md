# Temporal TS SDK: per-workflow module isolation silently disabled by webpack ≥ 5.108.0

Minimal reproduction for a bug in the Temporal TypeScript SDK where
**per-workflow module-state isolation is silently and completely disabled**
under `reuseV8Context: true` (the default), because the SDK's bundler wires up
its isolation with an exact-match string replacement that no longer matches
webpack's emitted runtime code.

**Affects:** any worker using `@temporalio/worker` 1.19.0 (and likely other
versions with the same bundler code) when npm/pnpm resolves webpack ≥ 5.108.0 —
which is **in-range for the SDK's own `^5.106.2` dependency**, so a fresh
install reproduces this.

**Boundary (confirmed with this repro):** webpack ≤ 5.107.x emits
`var __webpack_module_cache__` and isolation works; webpack ≥ 5.108.0 emits
`const __webpack_module_cache__` and isolation is silently disabled.

## Running the repro

```sh
npm install
npm run repro
```

The repro starts a local Temporal test server (downloaded automatically on
first run), runs a single-threaded worker with `reuseV8Context: true`, and
executes two workflows back-to-back. Each workflow writes its own workflow ID
into a **module-level** variable and reports what it found there. It also
rebuilds the workflow bundle and reports whether the SDK's module-cache
rewrite applied.

With the SDK's default webpack resolution (≥ 5.108.0), output looks like:

```
webpack version:         5.108.3
module cache in bundle:  ["const __webpack_module_cache__ = {}"]
SDK cache rewrite applied: false

probe-1 observed leaked module state from: null
probe-2 observed leaked module state from: probe-1

❌ ISOLATION BROKEN: workflow probe-2 observed module-level state written by workflow probe-1.
```

To demonstrate causation, pin webpack to a pre-5.108 version and re-run:

```sh
node swap-webpack.mjs 5.107.0   # or 5.106.2, the SDK's declared minimum
npm run repro
```

```
webpack version:         5.107.0
module cache in bundle:  ["var __webpack_module_cache__ = globalThis.__webpack_module_cache__"]
SDK cache rewrite applied: true

probe-1 observed leaked module state from: null
probe-2 observed leaked module state from: null

✅ Isolation intact: no module-level state leaked between executions.
```

Restore the default resolution with `node swap-webpack.mjs default`.

## Root cause

In `@temporalio/worker` v1.19.0:

- `packages/worker/src/workflow/bundler.ts` (`createBundle`):

  ```ts
  // Replace webpack's module cache with an object injected by the runtime.
  // This is the key to reusing a single v8 context.
  code = code.replace(
    'var __webpack_module_cache__ = {}',
    'var __webpack_module_cache__ = globalThis.__webpack_module_cache__'
  );
  ```

  Exact-match, single occurrence, **no verification that the replacement
  applied**.

- `packages/worker/src/workflow/reusable-vm.ts`
  (`ReusableVMWorkflowCreator`): defines `globalThis.__webpack_module_cache__`
  as a Proxy that routes module-cache reads/writes to either a `sharedModules`
  map (modules loaded before any workflow exists — SDK internals, deliberately
  shared and deep-frozen) or the current workflow's private
  `__TEMPORAL_ACTIVATOR__.moduleCache`. The bundle script is evaluated **once
  per worker thread**; workflow and interceptor modules are then imported
  per-workflow via `importWorkflows()` / `importInterceptors()` inside
  `initRuntime`, after the activator is set, so their module state lands in the
  per-workflow cache — *but only if the bundle's webpack runtime actually
  references the global proxy*.

Webpack modernized its runtime output to use `const`/`let` where the target
environment allows it (see webpack PR #21010 / `output.environment` handling).
As of webpack 5.108.0, the runtime emits:

```js
const __webpack_module_cache__ = {};
```

The SDK's `String.replace` finds nothing, **silently no-ops**, and the module
cache remains a bundle-local closure variable. The per-workflow proxy is never
consulted: the first `importWorkflows()` call populates the closure cache, and
every subsequent workflow on the thread reuses those module instances —
module-level state included.

## Why this is severe

Module-level state in workflow files is supposed to be per-workflow-execution
(and code in the wild relies on that). With this bug, all workflow executions
on a worker thread share all module-level state, for the lifetime of the
worker process. There is no error, no warning, and no workflow-task failure —
failures manifest as downstream weirdness.

How we found it (in a production-like system):

- A workflow that keeps scheduling state in module-level variables got
  **permanently stuck**: it resumed from a timer, found a module-level
  `Promise` left behind by a *different* workflow execution, and awaited it.
  A promise created in another execution's context can never settle inside
  this workflow's activations, so the workflow hung silently — every
  subsequent workflow task (signals, child-workflow completions) completed
  with zero commands, and signals were ignored indefinitely. A
  `__stack_trace` query showed the main coroutine parked on that foreign
  `await`.
- A query handler returning a module-level status object reported ~40
  "in-flight" items when the run's own event history contained only 8 child
  workflows — state accumulated from *other* executions sharing the module.
- An OpenTelemetry workflow interceptor that caches its tracer / context
  manager in module scope only performed its OTel global registration for the
  *first* workflow on each thread; every later workflow silently fell back to
  `NoopContextManager` (visible in stack-trace queries), quietly degrading
  tracing.

Additionally, workflow histories recorded under the broken isolation can
become **unreplayable** once isolation is restored (replay emits commands the
recorded history doesn't contain → non-determinism errors).

## Workarounds

1. Force webpack to emit `var` in runtime code so the SDK's rewrite applies
   again — in `Worker.create`'s `bundlerOptions.webpackConfigHook` (or
   `bundleWorkflowCode`'s `webpackConfigHook`):

   ```ts
   config.output = {
     ...config.output,
     environment: { ...config.output?.environment, const: false },
   };
   ```

2. Or set `reuseV8Context: false` — each workflow then gets its own V8 context
   and module graph regardless of the rewrite, at a significant memory cost.

Either way, consider bundling explicitly (`bundleWorkflowCode`) and failing
fast at startup if the emitted code does not contain
`globalThis.__webpack_module_cache__`.

## Suggested upstream fix

- Make the rewrite robust to modern runtime output (match
  `var`/`const`/`let`, or better, inject the wiring via a webpack runtime
  module instead of post-processing text), **and**
- Hard-fail the bundle build if the rewrite did not apply — a silent no-op
  here means total loss of workflow isolation.

## Files

- `src/workflows.ts` — `stateProbe` workflow with a module-level variable.
- `src/repro.ts` — bundle inspection + two-execution behavioral test
  (exits 1 when isolation is broken).
- `swap-webpack.mjs` — pins webpack via npm `overrides` to demonstrate the
  version boundary.

## References

- SDK bundler rewrite: <https://github.com/temporalio/sdk-typescript/blob/v1.19.0/packages/worker/src/workflow/bundler.ts> (see `createBundle`)
- Reusable VM / module-cache proxy: <https://github.com/temporalio/sdk-typescript/blob/v1.19.0/packages/worker/src/workflow/reusable-vm.ts>
- `reuseV8Context` docs: <https://typescript.temporal.io/api/interfaces/worker.WorkerOptions>
- Prior leak class (symbol-keyed globals, fixed in 1.12.0): <https://github.com/temporalio/sdk-typescript/issues/1592>
- Webpack modern runtime output (`const`/`let` emission): <https://github.com/webpack/webpack/releases> (PR #21010)
