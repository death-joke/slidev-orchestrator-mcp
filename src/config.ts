import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** Absolute path to the folder containing all presentations (one sub-folder each). */
  presentationsRoot: string;
  /** First port to try when starting Slidev dev servers. */
  basePort: number;
}

/**
 * Resolution order for the presentations root:
 *   1. CLI:  --dir <path>   (or first positional argument)
 *   2. Env:  SLIDEV_PRESENTATIONS_DIR
 * Fails fast with a clear message if none is provided or the path is invalid.
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let dir: string | undefined;

  const flagIdx = argv.findIndex((a) => a === "--dir" || a === "-d");
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    dir = argv[flagIdx + 1];
  } else {
    const positional = argv.find((a) => !a.startsWith("-"));
    if (positional) dir = positional;
  }

  dir ??= process.env.SLIDEV_PRESENTATIONS_DIR;

  if (!dir) {
    throw new Error(
      "No presentations directory provided. " +
        "Use `--dir /path/to/presentations` or set SLIDEV_PRESENTATIONS_DIR.",
    );
  }

  const presentationsRoot = resolve(dir);
  if (!existsSync(presentationsRoot) || !statSync(presentationsRoot).isDirectory()) {
    throw new Error(`Presentations directory not found: ${presentationsRoot}`);
  }

  const basePort = Number(process.env.SLIDEV_BASE_PORT ?? 3030);

  return { presentationsRoot, basePort };
}
