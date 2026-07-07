/**
 * Pin (or unpin) the webpack version used by @temporalio/worker's bundler,
 * to demonstrate that the isolation bug is caused by webpack's runtime
 * output switching from `var` to `const`.
 *
 * Usage:
 *   node swap-webpack.mjs <version>   # e.g. node swap-webpack.mjs 5.106.2
 *   node swap-webpack.mjs default     # remove the override
 *
 * Then re-run: pnpm run repro
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const version = process.argv[2];
if (!version) {
  console.error("usage: node swap-webpack.mjs <webpack-version | default>");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (version === "default") {
  delete pkg.overrides;
  console.log("Removed webpack override (npm will resolve the SDK's own range).");
} else {
  pkg.overrides = { ...pkg.overrides, webpack: version };
  console.log(`Pinned webpack to ${version} via package.json "overrides".`);
}
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

execSync("npm install", { stdio: "inherit" });
console.log("\nDone. Now run: pnpm run repro");
