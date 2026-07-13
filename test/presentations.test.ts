import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { useTmpDir } from "./helpers/tmp.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import {
  listPresentations,
  getPresentation,
  createPresentation,
  ensureThemeInstalled,
} from "../src/presentations.js";

/** A fake `npm install` child process that exits with the given code on the next microtask. */
function mockNpmInstall(exitCode: number, stderr = "") {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("exit", exitCode);
    });
    return child as unknown as ChildProcess;
  });
}

async function makePresentationFolder(
  root: string,
  name: string,
  opts: { slides?: string; withLocalSlidev?: boolean } = {},
) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "slides.md"),
    opts.slides ??
      `---
theme: seriph
title: My Talk
---

# Slide 1
`,
    "utf8",
  );
  if (opts.withLocalSlidev) {
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", ".bin", "slidev"), "", "utf8");
  }
  return dir;
}

describe("listPresentations", () => {
  const tmp = useTmpDir();

  it("finds folders that directly contain a slides.md", async () => {
    await makePresentationFolder(tmp.path(), "talk-a");
    const list = await listPresentations(tmp.path());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("talk-a");
    expect(list[0].entry).toBe(join(tmp.path(), "talk-a", "slides.md"));
  });

  it("ignores dotfiles, node_modules, and non-directories", async () => {
    await makePresentationFolder(tmp.path(), "talk-a");
    await mkdir(join(tmp.path(), ".hidden"), { recursive: true });
    await writeFile(join(tmp.path(), ".hidden", "slides.md"), "x", "utf8");
    await mkdir(join(tmp.path(), "node_modules"), { recursive: true });
    await writeFile(join(tmp.path(), "just-a-file.md"), "not a dir", "utf8");
    await mkdir(join(tmp.path(), "empty-folder"), { recursive: true });

    const list = await listPresentations(tmp.path());
    expect(list.map((p) => p.name)).toEqual(["talk-a"]);
  });

  it("parses title and theme from frontmatter", async () => {
    await makePresentationFolder(tmp.path(), "talk-a");
    const [info] = await listPresentations(tmp.path());
    expect(info.title).toBe("My Talk");
    expect(info.theme).toBe("seriph");
  });

  it("reports hasLocalSlidev based on node_modules/.bin/slidev", async () => {
    await makePresentationFolder(tmp.path(), "with-local", { withLocalSlidev: true });
    await makePresentationFolder(tmp.path(), "without-local");
    const list = await listPresentations(tmp.path());
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName["with-local"].hasLocalSlidev).toBe(true);
    expect(byName["without-local"].hasLocalSlidev).toBe(false);
  });

  it("returns an empty list for an empty root", async () => {
    const list = await listPresentations(tmp.path());
    expect(list).toEqual([]);
  });
});

describe("getPresentation", () => {
  const tmp = useTmpDir();

  it("returns the matching presentation", async () => {
    await makePresentationFolder(tmp.path(), "talk-a");
    const info = await getPresentation(tmp.path(), "talk-a");
    expect(info.name).toBe("talk-a");
  });

  it("throws listing available names when not found", async () => {
    await makePresentationFolder(tmp.path(), "talk-a");
    await makePresentationFolder(tmp.path(), "talk-b");
    await expect(getPresentation(tmp.path(), "missing")).rejects.toThrow(
      'Presentation "missing" not found. Available: talk-a, talk-b',
    );
  });

  it("throws with (none) when the root is empty", async () => {
    await expect(getPresentation(tmp.path(), "missing")).rejects.toThrow(
      'Presentation "missing" not found. Available: (none)',
    );
  });
});

describe("createPresentation", () => {
  const tmp = useTmpDir();

  it("scaffolds slides.md, package.json, and .gitignore", async () => {
    const info = await createPresentation(tmp.path(), { name: "new-talk", install: false });
    expect(info.name).toBe("new-talk");
    expect(info.hasLocalSlidev).toBe(false);

    const list = await listPresentations(tmp.path());
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("new-talk");
    expect(list[0].theme).toBe("default");
  });

  it("defaults the package.json theme dependency to @slidev/theme-default", async () => {
    await createPresentation(tmp.path(), { name: "default-theme", install: false });
    const pkgRaw = await readFile(join(tmp.path(), "default-theme", "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    expect(pkg.dependencies["@slidev/theme-default"]).toBeDefined();
  });

  it("uses @slidev/theme-<name> for a custom theme", async () => {
    await createPresentation(tmp.path(), {
      name: "custom-theme",
      theme: "seriph",
      install: false,
    });
    const pkgRaw = await readFile(join(tmp.path(), "custom-theme", "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    expect(pkg.dependencies["@slidev/theme-seriph"]).toBeDefined();
    expect(pkg.dependencies["@slidev/theme-default"]).toBeUndefined();
  });

  it("rejects invalid names", async () => {
    await expect(
      createPresentation(tmp.path(), { name: "bad name!", install: false }),
    ).rejects.toThrow("Invalid name");
  });

  it("throws if the folder already exists", async () => {
    await makePresentationFolder(tmp.path(), "existing");
    await expect(
      createPresentation(tmp.path(), { name: "existing", install: false }),
    ).rejects.toThrow("Folder already exists");
  });
});

describe("ensureThemeInstalled", () => {
  const tmp = useTmpDir();

  it("does nothing when theme is 'none'", async () => {
    const dir = await makePresentationFolder(tmp.path(), "talk-a");
    await expect(
      ensureThemeInstalled({
        name: "talk-a",
        path: dir,
        entry: join(dir, "slides.md"),
        theme: "none",
        hasLocalSlidev: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when the theme package is already installed", async () => {
    const dir = await makePresentationFolder(tmp.path(), "talk-a");
    await mkdir(join(dir, "node_modules", "@slidev", "theme-seriph"), { recursive: true });
    await expect(
      ensureThemeInstalled({
        name: "talk-a",
        path: dir,
        entry: join(dir, "slides.md"),
        theme: "seriph",
        hasLocalSlidev: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createPresentation (install: true, npm spawn mocked)", () => {
  const tmp = useTmpDir();

  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("resolves after a successful npm install", async () => {
    mockNpmInstall(0);
    const info = await createPresentation(tmp.path(), { name: "with-install" });

    expect(info.name).toBe("with-install");
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "--no-fund", "--no-audit"],
      expect.objectContaining({ cwd: join(tmp.path(), "with-install") }),
    );
  });

  it("rejects when npm install fails", async () => {
    mockNpmInstall(1, "boom");
    await expect(createPresentation(tmp.path(), { name: "install-fails" })).rejects.toThrow(
      "npm install failed (1)",
    );
  });
});

describe("ensureThemeInstalled (npm spawn mocked)", () => {
  const tmp = useTmpDir();

  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("installs the missing theme package", async () => {
    mockNpmInstall(0);
    const dir = await makePresentationFolder(tmp.path(), "talk-a");

    await ensureThemeInstalled({
      name: "talk-a",
      path: dir,
      entry: join(dir, "slides.md"),
      theme: "seriph",
      hasLocalSlidev: false,
    });

    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "@slidev/theme-seriph", "--no-fund", "--no-audit"],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it("rejects when the install fails", async () => {
    mockNpmInstall(1, "boom");
    const dir = await makePresentationFolder(tmp.path(), "talk-b");

    await expect(
      ensureThemeInstalled({
        name: "talk-b",
        path: dir,
        entry: join(dir, "slides.md"),
        theme: "seriph",
        hasLocalSlidev: false,
      }),
    ).rejects.toThrow("npm install @slidev/theme-seriph failed (1)");
  });
});
