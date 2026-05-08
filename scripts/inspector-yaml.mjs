#!/usr/bin/env node

// Launches @modelcontextprotocol/inspector against a YAML config, defaulting
// to ./config.yaml when no argument is given. Pre-checks the file exists
// before spawning so the inspector doesn't restart-loop on a missing config
// (its default behaviour when the spawned server exits non-zero on startup,
// which obscures the real cause).
//
// Cross-platform replacement for the previous `bash -c` wrapper in
// package.json. Driven by `npm run inspector:yaml [-- path/to/your.yaml]`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const configPath = process.argv[2] ?? "config.yaml";
const absolutePath = resolve(configPath);

if (!existsSync(absolutePath)) {
  process.stderr.write(
    `inspector:yaml: config file not found: ${configPath}\n` +
      `  cwd: ${process.cwd()}\n` +
      `  hint: pass an explicit path with: npm run inspector:yaml -- path/to/your.yaml\n`,
  );
  process.exit(1);
}

// `npx` is `npx.cmd` on Windows; spawning the bare name there fails with
// ENOENT unless the platform-specific extension is supplied.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(
  npx,
  [
    "@modelcontextprotocol/inspector",
    "node",
    "dist/index.js",
    "--config",
    configPath,
  ],
  { stdio: "inherit" },
);

// Forward Ctrl-C / kill signals to the inspector so it can shut down its
// own child (the spawned mcp-confluent server) cleanly. Without this the
// parent exits before the child has a chance to clean up its localhost
// listener.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Surface the killing signal in the parent's exit so the shell sees the
    // expected 128+N convention.
    process.exit(128 + (signalNumber(signal) ?? 0));
  }
  process.exit(code ?? 0);
});

/**
 * Best-effort numeric value for a Node signal name, so the parent can
 * exit with the conventional 128+N when the child was killed by signal.
 * Falls back to undefined for signals not in this small set; the caller
 * substitutes 0 in that case.
 */
function signalNumber(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[signal];
}
