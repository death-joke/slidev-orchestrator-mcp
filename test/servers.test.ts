import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Server } from "node:net";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import type { PresentationInfo } from "../src/presentations.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:net", () => ({ createServer: vi.fn() }));
vi.mock("node:os", () => ({ networkInterfaces: vi.fn() }));

import { slidevCommand, DevServerManager } from "../src/servers.js";

function presentation(overrides: Partial<PresentationInfo> = {}): PresentationInfo {
  return {
    name: "talk-a",
    path: "/tmp/talk-a",
    entry: "/tmp/talk-a/slides.md",
    hasLocalSlidev: false,
    ...overrides,
  };
}

/** A fake ChildProcess whose kill() simulates the process exiting on the next microtask. */
function createFakeChild(overrides: { pid?: number; exitCode?: number | null } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    exitCode: number | null;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
  };
  child.pid = overrides.pid ?? 12345;
  child.exitCode = overrides.exitCode ?? null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, signal ?? null);
    });
    return true;
  });
  return child as unknown as ChildProcess;
}

/** A fake net.Server whose listen() resolves as "listening" or "error" on the next microtask. */
function createFakeNetServer(succeeds: boolean) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const server = {
    once(event: string, cb: (...args: unknown[]) => void) {
      handlers[event] = cb;
      return server;
    },
    listen() {
      queueMicrotask(() => {
        if (succeeds) handlers.listening?.();
        else handlers.error?.(new Error("EADDRINUSE"));
      });
      return server;
    },
    close(cb?: () => void) {
      cb?.();
    },
  };
  return server as unknown as Server;
}

async function withPlatform(platform: NodeJS.Platform, fn: () => void | Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("slidevCommand", () => {
  it("uses the local binary when hasLocalSlidev is true", async () => {
    await withPlatform("darwin", () => {
      const { command, args } = slidevCommand(presentation({ hasLocalSlidev: true }));
      expect(command).toBe("/tmp/talk-a/node_modules/.bin/slidev");
      expect(args).toEqual([]);
    });
  });

  it("uses slidev.cmd on win32 when hasLocalSlidev is true", async () => {
    await withPlatform("win32", () => {
      const { command } = slidevCommand(presentation({ hasLocalSlidev: true }));
      expect(command).toBe("/tmp/talk-a/node_modules/.bin/slidev.cmd");
    });
  });

  it("falls back to npx when there is no local slidev", () => {
    const { command, args } = slidevCommand(presentation({ hasLocalSlidev: false }));
    expect(command).toBe("npx");
    expect(args).toEqual(["-y", "@slidev/cli"]);
  });
});

describe("DevServerManager (no spawned processes)", () => {
  const manager = new DevServerManager(3030);

  afterEach(async () => {
    await manager.stopAll();
  });

  it("starts with an empty server list", () => {
    expect(manager.list()).toEqual([]);
  });

  it("reports isRunning as false for an unknown presentation", () => {
    expect(manager.isRunning("nope")).toBe(false);
  });

  it("returns an empty logs array for an unknown presentation", () => {
    expect(manager.logs("nope")).toEqual([]);
  });

  it("stop() resolves false for a presentation that isn't running", async () => {
    await expect(manager.stop("nope")).resolves.toBe(false);
  });

  it("stopAll() resolves when nothing is running", async () => {
    await expect(manager.stopAll()).resolves.toBeUndefined();
  });
});

describe("DevServerManager (mocked spawn/net/os)", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(createServer).mockReset();
    vi.mocked(networkInterfaces).mockReset().mockReturnValue({});
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.SLIDEV_PUBLIC_HOST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws if the child process exits before becoming ready", async () => {
    vi.mocked(spawn).mockReturnValue(createFakeChild({ exitCode: 1 }));
    const manager = new DevServerManager(3030);
    await expect(manager.start(presentation(), 4001)).rejects.toThrow("Slidev exited early");
  });

  it("resolves when the dev server becomes reachable on the requested port", async () => {
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    const running = await manager.start(presentation({ name: "talk-a" }), 4002);

    expect(running.port).toBe(4002);
    expect(running.url).toContain(":4002");
    expect(manager.isRunning("talk-a")).toBe(true);
    expect(manager.list()).toHaveLength(1);
  });

  it("throws if a server for that presentation is already running", async () => {
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    await manager.start(presentation({ name: "talk-a" }), 4003);
    await expect(manager.start(presentation({ name: "talk-a" }), 4003)).rejects.toThrow(
      'Server for "talk-a" already running',
    );
  });

  it("collects stdout/stderr chunks into logs()", async () => {
    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    await manager.start(presentation({ name: "talk-a" }), 4004);
    (child.stdout as unknown as EventEmitter).emit("data", Buffer.from("hello\n"));

    expect(manager.logs("talk-a")).toEqual(["hello\n"]);
  });

  it("stops a running server and removes it from the list", async () => {
    await withPlatform("win32", async () => {
      vi.mocked(spawn).mockReturnValue(createFakeChild());
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const manager = new DevServerManager(3030);
      await manager.start(presentation({ name: "talk-a" }), 4005);
      const stopped = await manager.stop("talk-a");

      expect(stopped).toBe(true);
      expect(manager.isRunning("talk-a")).toBe(false);
    });
  });

  it("stopAll() stops every running server", async () => {
    await withPlatform("win32", async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(createFakeChild())
        .mockReturnValueOnce(createFakeChild());
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const manager = new DevServerManager(3030);
      await manager.start(presentation({ name: "talk-a" }), 4006);
      await manager.start(presentation({ name: "talk-b" }), 4007);
      await manager.stopAll();

      expect(manager.list()).toEqual([]);
    });
  });

  it("auto-allocates the first free port when none is requested", async () => {
    vi.mocked(createServer).mockReturnValue(createFakeNetServer(true));
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(4100);
    const running = await manager.start(presentation({ name: "talk-a" }));

    expect(running.port).toBe(4100);
  });

  it("skips ports that are already in use by the OS", async () => {
    vi.mocked(createServer)
      .mockImplementationOnce(() => createFakeNetServer(false))
      .mockImplementationOnce(() => createFakeNetServer(true));
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(4200);
    const running = await manager.start(presentation({ name: "talk-a" }));

    expect(running.port).toBe(4201);
  });

  it("skips ports already assigned to other running servers", async () => {
    vi.mocked(createServer).mockReturnValue(createFakeNetServer(true));
    vi.mocked(spawn).mockReturnValueOnce(createFakeChild()).mockReturnValueOnce(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(4300);
    await manager.start(presentation({ name: "talk-a" }), 4300);
    const running = await manager.start(presentation({ name: "talk-b" }));

    expect(running.port).toBe(4301);
  });

  it("throws when no free port can be found", async () => {
    vi.mocked(createServer).mockReturnValue(createFakeNetServer(false));
    const manager = new DevServerManager(4400);
    await expect(manager.start(presentation({ name: "talk-a" }))).rejects.toThrow(
      "No free port found.",
    );
  });

  it("uses SLIDEV_PUBLIC_HOST when set", async () => {
    process.env.SLIDEV_PUBLIC_HOST = "example.test";
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    const running = await manager.start(presentation({ name: "talk-a" }), 4500);

    expect(running.url).toBe("http://example.test:4500");
  });

  it("falls back to the first non-internal IPv4 interface", async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      eth0: [{ family: "IPv4", internal: false, address: "10.0.0.5" }] as never,
    });
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    const running = await manager.start(presentation({ name: "talk-a" }), 4600);

    expect(running.url).toBe("http://10.0.0.5:4600");
  });

  it("falls back to localhost when no usable interface is found", async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] as never,
    });
    vi.mocked(spawn).mockReturnValue(createFakeChild());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const manager = new DevServerManager(3030);
    const running = await manager.start(presentation({ name: "talk-a" }), 4700);

    expect(running.url).toBe("http://localhost:4700");
  });
});
