import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PresentationInfo } from "../src/presentations.js";

const connectMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = callToolMock;
    close = closeMock;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));

import { SlidevProxy, proxiedName } from "../src/slidev-proxy.js";

function presentation(overrides: Partial<PresentationInfo> = {}): PresentationInfo {
  return {
    name: "talk-a",
    path: "/tmp/talk-a",
    entry: "/tmp/talk-a/slides.md",
    hasLocalSlidev: false,
    ...overrides,
  };
}

describe("proxiedName", () => {
  it("prefixes with slidev_", () => {
    expect(proxiedName("get_slides")).toBe("slidev_get_slides");
  });

  it("sanitizes characters outside [a-zA-Z0-9_-]", () => {
    expect(proxiedName("get slides")).toBe("slidev_get_slides");
    expect(proxiedName("weird/name.tool")).toBe("slidev_weird_name_tool");
  });
});

describe("SlidevProxy (no connection established)", () => {
  it("has null target and empty tools before connect()", () => {
    const proxy = new SlidevProxy();
    expect(proxy.target).toBeNull();
    expect(proxy.tools).toEqual([]);
  });

  it("call() rejects when no presentation is targeted", async () => {
    const proxy = new SlidevProxy();
    await expect(proxy.call("anything", {})).rejects.toThrow(
      "No presentation targeted. Call `select_presentation` first.",
    );
  });

  it("close() resolves without a client connected", async () => {
    const proxy = new SlidevProxy();
    await expect(proxy.close()).resolves.toBeUndefined();
    expect(proxy.target).toBeNull();
    expect(proxy.tools).toEqual([]);
  });
});

describe("SlidevProxy (connected, MCP client mocked)", () => {
  beforeEach(() => {
    connectMock.mockReset().mockResolvedValue(undefined);
    listToolsMock.mockReset().mockResolvedValue({ tools: [{ name: "get_slides" }] });
    callToolMock.mockReset().mockResolvedValue({ content: [] });
    closeMock.mockReset().mockResolvedValue(undefined);
  });

  it("connects and exposes the child's tools", async () => {
    const proxy = new SlidevProxy();
    const tools = await proxy.connect(presentation());

    expect(tools).toEqual([{ name: "get_slides" }]);
    expect(proxy.target?.name).toBe("talk-a");
    expect(proxy.tools).toEqual([{ name: "get_slides" }]);
  });

  it("closes any previous connection before reconnecting", async () => {
    const proxy = new SlidevProxy();
    await proxy.connect(presentation({ name: "talk-a" }));
    await proxy.connect(presentation({ name: "talk-b" }));

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(proxy.target?.name).toBe("talk-b");
  });

  it("forwards call() to the underlying client with the given arguments", async () => {
    const proxy = new SlidevProxy();
    await proxy.connect(presentation());
    await proxy.call("get_slides", { foo: "bar" });

    expect(callToolMock).toHaveBeenCalledWith({ name: "get_slides", arguments: { foo: "bar" } });
  });

  it("defaults call() arguments to {} when undefined", async () => {
    const proxy = new SlidevProxy();
    await proxy.connect(presentation());
    await proxy.call("get_slides", undefined);

    expect(callToolMock).toHaveBeenCalledWith({ name: "get_slides", arguments: {} });
  });

  it("close() resets state and swallows client close errors", async () => {
    closeMock.mockRejectedValueOnce(new Error("already gone"));
    const proxy = new SlidevProxy();
    await proxy.connect(presentation());

    await expect(proxy.close()).resolves.toBeUndefined();
    expect(proxy.target).toBeNull();
    expect(proxy.tools).toEqual([]);
  });
});
