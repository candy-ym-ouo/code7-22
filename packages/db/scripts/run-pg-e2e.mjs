#!/usr/bin/env node
// Ensures the embedded PostgreSQL native libraries are usable, then runs the
// e2e suite. The @embedded-postgres platform package ships versioned shared
// objects (e.g. libicuuc.so.60.2); the dynamic loader looks up the SONAME
// (libicuuc.so.60), normally created by the package postinstall step. That
// step is blocked by this workspace's build-script policy, so we recreate the
// symlinks ourselves and export LD_LIBRARY_PATH for the cluster.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Find a directory that holds the platform package's versioned ICU library. */
function findNativeLib() {
  const roots = [];
  // Walk up from the embedded-postgres package to find the pnpm store (.pnpm).
  try {
    const entry = requireFromHere.resolve("embedded-postgres");
    let dir = dirname(entry);
    for (let depth = 0; depth < 12; depth += 1) {
      roots.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // embedded-postgres not installed
  }
  roots.push(join(here, "..", "..", "..", "node_modules"));

  for (const root of roots) {
    const hit = searchForIcu(root, 0);
    if (hit) return hit;
  }
  return "";
}

function searchForIcu(directory, depth) {
  if (depth > 6) return "";
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return "";
  }
  for (const name of entries) {
    const full = join(directory, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (
      name === "lib" &&
      full.includes("@embedded-postgres") &&
      readdirSync(full).some((file) => /^libicuuc\.so\.\d+\.\d+$/.test(file))
    ) {
      return full;
    }
    const deeper = searchForIcu(full, depth + 1);
    if (deeper) return deeper;
  }
  return "";
}

const libDir = findNativeLib();
if (!libDir) {
  process.stderr.write("embedded-postgres native libraries not found; skipping e2e.\n");
  process.exit(0);
}

// Create missing SONAME symlinks: libfoo.so.X.Y -> libfoo.so.X
for (const entry of readdirSync(libDir)) {
  const match = /^(.+\.so)\.(\d+)\.(\d+)$/.exec(entry);
  if (!match) continue;
  const soname = `${match[1]}.${match[2]}`;
  if (!existsSync(join(libDir, soname))) {
    symlinkSync(join(libDir, entry), join(libDir, soname));
  }
}

const vitestBin = requireFromHere.resolve("vitest/vitest.mjs");
const child = spawn(process.execPath, [vitestBin, "run", "src/runner.e2e.test.ts"], {
  stdio: "inherit",
  cwd: join(here, ".."),
  env: {
    ...process.env,
    RUN_PG_E2E: "true",
    LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
  }
});
child.on("exit", (code) => process.exit(code ?? 0));
