import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const THEME_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_PACKAGE_PATTERNS = [
  /^@slidev\/theme-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  /^slidev-theme-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  /^@[a-z0-9]+(?:-[a-z0-9]+)*\/slidev-theme-[a-z0-9]+(?:-[a-z0-9]+)*$/,
];

/** Maps a theme identifier to an npm package, rejecting anything that isn't a
 * recognized Slidev theme naming convention (prevents installing an arbitrary
 * package via a crafted `theme` value). */
function resolveThemePackage(theme: string): string {
  if (THEME_NAME.test(theme)) return `@slidev/theme-${theme}`;
  if (THEME_PACKAGE_PATTERNS.some((re) => re.test(theme))) return theme;
  throw new Error(
    `Invalid theme "${theme}": expected a bare name (e.g. "seriph"), "@slidev/theme-*", ` +
      `"slidev-theme-*", or "@scope/slidev-theme-*".`,
  );
}

/** Resolves the currently published version of a package and pins it, instead
 * of persisting an unpinned "latest" range in scaffolded package.json files. */
async function resolveVersion(pkg: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("npm", ["view", pkg, "version"], {
      shell: process.platform === "win32",
    });
    const version = stdout.trim();
    return version ? `^${version}` : "latest";
  } catch {
    return "latest";
  }
}

export interface PresentationInfo {
  name: string;
  path: string;
  entry: string; // absolute path to slides.md
  title?: string;
  theme?: string;
  hasLocalSlidev: boolean;
}

const ENTRY_FILE = "slides.md";

/** A folder is a presentation if it directly contains a slides.md. */
export async function listPresentations(root: string): Promise<PresentationInfo[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: PresentationInfo[] = [];

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const dir = join(root, e.name);
    const entry = join(dir, ENTRY_FILE);
    if (!existsSync(entry)) continue;

    const info: PresentationInfo = {
      name: e.name,
      path: dir,
      entry,
      hasLocalSlidev: existsSync(join(dir, "node_modules", ".bin", "slidev")),
    };

    // Best-effort: read title/theme from the frontmatter of slides.md
    try {
      const head = (await readFile(entry, "utf8")).slice(0, 2000);
      const fm = head.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        info.title = fm[1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
        info.theme = fm[1].match(/^theme:\s*(.+)$/m)?.[1]?.trim();
      }
    } catch {
      /* ignore */
    }

    result.push(info);
  }
  return result;
}

export async function getPresentation(root: string, name: string): Promise<PresentationInfo> {
  const all = await listPresentations(root);
  const found = all.find((p) => p.name === name);
  if (!found) {
    const names = all.map((p) => p.name).join(", ") || "(none)";
    throw new Error(`Presentation "${name}" not found. Available: ${names}`);
  }
  return found;
}

export interface CreateOptions {
  name: string;
  title?: string;
  theme?: string;
  install?: boolean; // run npm install after scaffolding
}

/** Scaffold <root>/<name>/ with slides.md + package.json (local @slidev/cli). */
export async function createPresentation(
  root: string,
  opts: CreateOptions,
): Promise<PresentationInfo> {
  if (!/^[a-zA-Z0-9._-]+$/.test(opts.name)) {
    throw new Error("Invalid name: use only letters, digits, '.', '_' and '-'.");
  }
  const dir = join(root, opts.name);
  if (existsSync(dir)) throw new Error(`Folder already exists: ${dir}`);

  const title = opts.title ?? opts.name;
  const theme = opts.theme ?? "default";
  if (theme !== "default" && theme !== "none" && !THEME_NAME.test(theme)) {
    throw new Error(`Invalid theme "${theme}": use a bare name, e.g. "seriph".`);
  }

  await mkdir(dir, { recursive: true });

  const slides = `---
theme: ${theme}
title: ${title}
info: |
  ## ${title}
transition: slide-left
mdc: true
---

# ${title}

Press <kbd>space</kbd> to start

---

# Slide 2

- Point 1
- Point 2
`;

  const themePkg =
    theme !== "default" && theme !== "none" ? `@slidev/theme-${theme}` : "@slidev/theme-default";
  const [cliVersion, themeVersion, vueVersion] = await Promise.all([
    resolveVersion("@slidev/cli"),
    resolveVersion(themePkg),
    resolveVersion("vue"),
  ]);

  const pkg = {
    name: `slides-${opts.name.toLowerCase()}`,
    private: true,
    type: "module",
    scripts: {
      dev: "slidev --open",
      build: "slidev build",
      export: "slidev export",
    },
    dependencies: {
      "@slidev/cli": cliVersion,
      [themePkg]: themeVersion,
      vue: vueVersion,
    },
  };

  await writeFile(join(dir, ENTRY_FILE), slides, "utf8");
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  await writeFile(join(dir, ".gitignore"), "node_modules\ndist\n.slidev\n", "utf8");

  if (opts.install !== false) {
    await runInstall(dir);
  }

  return {
    name: opts.name,
    path: dir,
    entry: join(dir, ENTRY_FILE),
    title,
    theme,
    hasLocalSlidev: existsSync(join(dir, "node_modules", ".bin", "slidev")),
  };
}

function runInstall(cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("npm", ["install", "--no-fund", "--no-audit"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`npm install failed (${code}): ${stderr.slice(-500)}`)),
    );
  });
}

function runInstallPkg(cwd: string, pkg: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("npm", ["install", pkg, "--no-fund", "--no-audit"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0
        ? res()
        : rej(new Error(`npm install ${pkg} failed (${code}): ${stderr.slice(-500)}`)),
    );
  });
}

export async function ensureThemeInstalled(p: PresentationInfo): Promise<void> {
  const theme = p.theme ?? "default";
  if (theme === "none") return;
  const pkg = resolveThemePackage(theme);
  if (existsSync(join(p.path, "node_modules", ...pkg.split("/")))) return;
  await runInstallPkg(p.path, pkg);
}
