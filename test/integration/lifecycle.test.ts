import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresentation } from "../../src/presentations.js";
import { DevServerManager } from "../../src/servers.js";
import { SlidevProxy } from "../../src/slidev-proxy.js";

/**
 * These tests spin up a real Slidev presentation: they run `npm install`
 * and spawn actual `slidev` / `slidev mcp` child processes. That makes them
 * slow and network-dependent, so they only run when explicitly requested:
 *
 *   npm run test:integration
 */
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN_INTEGRATION)("create -> start -> proxy -> stop (integration)", () => {
  let root = "";
  const devServers = new DevServerManager(3830);
  const proxy = new SlidevProxy();

  afterEach(async () => {
    await proxy.close();
    await devServers.stopAll();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs the full lifecycle without leaving orphaned processes", async () => {
    root = await mkdtemp(join(tmpdir(), "slidev-integration-"));

    const info = await createPresentation(root, { name: "e2e-talk", install: true });
    expect(info.hasLocalSlidev).toBe(true);

    const running = await devServers.start(info);
    expect(devServers.isRunning("e2e-talk")).toBe(true);
    expect(running.url).toMatch(/^http:\/\//);

    const res = await fetch(running.url);
    expect(res.status).toBeLessThan(500);

    const tools = await proxy.connect(info);
    expect(tools.length).toBeGreaterThan(0);
    await proxy.close();
    expect(proxy.target).toBeNull();

    const stopped = await devServers.stop("e2e-talk");
    expect(stopped).toBe(true);
    expect(devServers.isRunning("e2e-talk")).toBe(false);
  });
});
