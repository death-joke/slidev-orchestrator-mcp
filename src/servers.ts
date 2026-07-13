import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { PresentationInfo } from "./presentations.js";
import { networkInterfaces } from "node:os";

export interface RunningServer {
  name: string;
  port: number;
  url: string;
  presenterUrl: string;
  pid: number;

  startedAt: string;
}

interface Entry extends RunningServer {
  child: ChildProcess;
  logs: string[];
}

/** Command to run the slidev CLI inside a presentation folder. */
export function slidevCommand(p: PresentationInfo): { command: string; args: string[] } {
  // Prefer the locally installed binary; fall back to npx (package is @slidev/cli).
  if (p.hasLocalSlidev) {
    const bin = process.platform === "win32" ? "slidev.cmd" : "slidev";
    return { command: `${p.path}/node_modules/.bin/${bin}`, args: [] };
  }
  return { command: "npx", args: ["-y", "@slidev/cli"] };
}

export class DevServerManager {
  private servers = new Map<string, Entry>();

  constructor(private basePort: number) {}

  list(): RunningServer[] {
    return [...this.servers.values()].map(({ child, logs, ...pub }) => pub);
  }

  isRunning(name: string): boolean {
    return this.servers.has(name);
  }

  logs(name: string): string[] {
    return this.servers.get(name)?.logs ?? [];
  }

  async start(p: PresentationInfo, requestedPort?: number): Promise<RunningServer> {
    if (this.servers.has(p.name)) {
      const s = this.servers.get(p.name)!;
      throw new Error(`Server for "${p.name}" already running at ${s.url}`);
    }

    const port = requestedPort ?? (await this.freePort());
    const { command, args } = slidevCommand(p);

    const child = spawn(command, [...args, "slides.md", "--port", String(port), "--remote"], {
      cwd: p.path,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: process.platform !== "win32", // <- groupe de process dédié sur Unix
    });
    const host = machineHost();
    const entry: Entry = {
      name: p.name,
      port,
      url: `http://${host}:${port}`,
      presenterUrl: `http://${host}:${port}/presenter`,
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      child,
      logs: [],
    };

    const pushLog = (d: Buffer) => {
      entry.logs.push(d.toString());
      if (entry.logs.length > 200) entry.logs.shift();
    };
    child.stdout?.on("data", pushLog);
    child.stderr?.on("data", pushLog);
    child.on("exit", () => this.servers.delete(p.name));

    // Wait for the dev server to be reachable (or the process to die).
    await this.waitReady(entry, 30_000);

    this.servers.set(p.name, entry);
    const presenterUrl = `${entry.url}/presenter`;
    return {
      name: entry.name,
      port,
      url: entry.url,
      presenterUrl: presenterUrl,
      pid: entry.pid,
      startedAt: entry.startedAt,
    };
  }

  async stop(name: string): Promise<boolean> {
    const entry = this.servers.get(name);
    if (!entry) return false;
    this.servers.delete(name);
    await killTree(entry.child);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((n) => this.stop(n)));
  }

  private async waitReady(entry: Entry, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.child.exitCode !== null) {
        throw new Error(
          `Slidev exited early (code ${entry.child.exitCode}). Last logs:\n` +
            entry.logs.slice(-10).join(""),
        );
      }
      try {
        // dans waitReady, teste toujours en local :
        const res = await fetch(`http://localhost:${entry.port}`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok || res.status < 500) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    await killTree(entry.child);
    throw new Error(`Timed out waiting for Slidev on port ${entry.port}.`);
  }

  private async freePort(): Promise<number> {
    const used = new Set([...this.servers.values()].map((s) => s.port));
    for (let port = this.basePort; port < this.basePort + 100; port++) {
      if (used.has(port)) continue;
      if (await portAvailable(port)) return port;
    }
    throw new Error("No free port found.");
  }
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();

    const pid = child.pid;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once("exit", done);

    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") {
          child.kill(sig); // pas de groupes POSIX sur Windows
        } else {
          process.kill(-pid, sig); // PID négatif = tout le groupe
        }
      } catch {
        // ESRCH = déjà mort ; EPERM = plus dans notre groupe -> fallback direct
        try {
          child.kill(sig);
        } catch {
          /* ignore */
        }
      }
    };

    signal("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) signal("SIGKILL");
      // filet de sécurité si l'event 'exit' n'arrive pas
      setTimeout(done, 500).unref();
    }, 3000).unref();
  });
}

function machineHost(): string {
  if (process.env.SLIDEV_PUBLIC_HOST) return process.env.SLIDEV_PUBLIC_HOST;
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      // IPv4, non-loopback, non-interne
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}
