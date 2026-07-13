import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";

/**
 * Creates a fresh temp directory before each test and removes it afterwards.
 * Call this inside a `describe` block; use the returned `path()` getter inside
 * test bodies (the directory only exists once `beforeEach` has run).
 */
export function useTmpDir(prefix = "slidev-test-"): { path: () => string } {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  return { path: () => dir };
}
