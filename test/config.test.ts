import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { useTmpDir } from "./helpers/tmp.js";

describe("loadConfig", () => {
  const tmp = useTmpDir();
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SLIDEV_PRESENTATIONS_DIR;
    delete process.env.SLIDEV_BASE_PORT;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("resolves the directory from --dir", () => {
    const config = loadConfig(["--dir", tmp.path()]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("resolves the directory from -d", () => {
    const config = loadConfig(["-d", tmp.path()]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("resolves the directory from a positional argument", () => {
    const config = loadConfig([tmp.path()]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("falls back to SLIDEV_PRESENTATIONS_DIR when no CLI arg is given", () => {
    process.env.SLIDEV_PRESENTATIONS_DIR = tmp.path();
    const config = loadConfig([]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("prefers --dir over a positional argument", () => {
    const config = loadConfig(["--dir", tmp.path(), "ignored-positional"]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("prefers a CLI arg over the env var", () => {
    process.env.SLIDEV_PRESENTATIONS_DIR = "/should/not/be/used";
    const config = loadConfig(["--dir", tmp.path()]);
    expect(config.presentationsRoot).toBe(resolve(tmp.path()));
  });

  it("throws when no directory is provided at all", () => {
    expect(() => loadConfig([])).toThrow("No presentations directory provided");
  });

  it("throws when the resolved path does not exist", () => {
    expect(() => loadConfig(["--dir", join(tmp.path(), "does-not-exist")])).toThrow(
      "Presentations directory not found",
    );
  });

  it("throws when the resolved path is not a directory", async () => {
    const filePath = join(tmp.path(), "not-a-dir.txt");
    await writeFile(filePath, "hello");
    expect(() => loadConfig(["--dir", filePath])).toThrow("Presentations directory not found");
  });

  it("defaults basePort to 3030", () => {
    const config = loadConfig(["--dir", tmp.path()]);
    expect(config.basePort).toBe(3030);
  });

  it("overrides basePort from SLIDEV_BASE_PORT", () => {
    process.env.SLIDEV_BASE_PORT = "4040";
    const config = loadConfig(["--dir", tmp.path()]);
    expect(config.basePort).toBe(4040);
  });
});
