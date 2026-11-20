#!/usr/bin/env node
/**
 * Starts the PriceCatcher Explorer and opens it in the browser.
 *
 *   1. Rebuilds datasets/derived/cube.parquet if the raw data is newer (or it's missing).
 *   2. Runs the Next.js dev server for explorer/ on http://localhost:3939.
 *   3. Opens that URL once the server reports it's ready.
 *
 * Usage: npm run explorer [-- --no-open]
 */

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL = "http://localhost:3939";
const open = !process.argv.includes("--no-open");

const build = spawnSync(process.execPath, [join(ROOT, "scripts", "build-cube.mjs"), "--if-stale"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const server = spawn(npm, ["run", "dev", "-w", "explorer"], {
  cwd: ROOT,
  stdio: ["inherit", "pipe", "inherit"],
});

let opened = false;
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (open && !opened && /Ready in|Local:/.test(chunk.toString())) {
    opened = true;
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [URL], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 0));
