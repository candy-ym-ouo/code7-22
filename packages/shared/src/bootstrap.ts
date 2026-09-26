import { ConfigValidationError } from "./env";

/**
 * Process-level fatal handlers, registered on import. Import this module
 * FIRST in every entry point (`import "@map/shared/bootstrap"`) before any
 * module that parses configuration, so that invalid environment fails with a
 * clean, operator-readable message and exit code 1 instead of a raw
 * uncaught-exception stack dump.
 *
 * After startup this keeps fail-fast semantics for unexpected errors: the
 * process exits non-zero and the orchestrator restarts or holds the rollout.
 */
export function reportFatal(error: unknown, kind: string): never {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`\n${error.message}\n\n`);
  } else {
    process.stderr.write(`\nFatal ${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`);
  }
  process.exit(1);
}

process.on("uncaughtException", (error) => reportFatal(error, "uncaughtException"));
process.on("unhandledRejection", (reason) => reportFatal(reason, "unhandledRejection"));
