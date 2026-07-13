#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import {
  createPresentation,
  ensureThemeInstalled,
  getPresentation,
  listPresentations,
} from "./presentations.js";
import { DevServerManager } from "./servers.js";
import { SlidevProxy, proxiedName } from "./slidev-proxy.js";

const config = loadConfig();
const devServers = new DevServerManager(config.basePort);
const proxy = new SlidevProxy();

const server = new Server(
  { name: "slidev-orchestrator", version: "0.1.0" },
  { capabilities: { tools: { listChanged: true } } },
);

// ---------------------------------------------------------------------------
// Static management tools
// ---------------------------------------------------------------------------

const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: "list_presentations",
    description:
      "List all Slidev presentations found in the presentations root directory " +
      `(${config.presentationsRoot}). A presentation is any sub-folder containing a slides.md.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_presentation",
    description:
      "Scaffold a new Slidev presentation (folder + slides.md + package.json) in the root directory. " +
      "Runs `npm install` unless install=false.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name (letters, digits, . _ -)" },
        title: { type: "string", description: "Presentation title (defaults to name)" },
        theme: { type: "string", description: "Slidev theme, e.g. 'default', 'seriph'" },
        install: { type: "boolean", description: "Run npm install (default true)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "start_server",
    description:
      "Start the Slidev dev server for a presentation. Returns the local URL. " +
      "Ports are allocated automatically unless `port` is given.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Presentation folder name" },
        port: { type: "number", description: "Optional fixed port" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_server",
    description: "Stop the running Slidev dev server of a presentation.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "server_status",
    description: "List all currently running Slidev dev servers (name, port, URL, pid).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "select_presentation",
    description:
      "Target a presentation: connects to its official `slidev mcp` server and dynamically " +
      "exposes its tools (prefixed `slidev_*`) for inspecting/editing the slides. " +
      "Selecting a new presentation replaces the previous target.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Presentation folder name" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "call_slidev_tool",
    description:
      "Fallback passthrough: call a tool of the currently targeted presentation's official " +
      "Slidev MCP by its original name. Useful for MCP clients that do not support dynamic " +
      "tool list updates (tools/list_changed).",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Original tool name on the Slidev MCP" },
        args: { type: "object", description: "Arguments for that tool" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
];

// Currently proxied tools: prefixed name -> original child tool
const proxiedTools = new Map<string, Tool>();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const dynamic: Tool[] = [...proxiedTools.entries()].map(([name, t]) => ({
    ...t,
    name,
    description: `[${proxy.target?.name ?? "?"}] ${t.description ?? ""}`.trim(),
  }));
  return { tools: [...MANAGEMENT_TOOLS, ...dynamic] };
});

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "list_presentations": {
        const list = await listPresentations(config.presentationsRoot);
        const enriched = list.map((p) => ({
          ...p,
          devServerRunning: devServers.isRunning(p.name),
          targeted: proxy.target?.name === p.name,
        }));
        return json(enriched);
      }

      case "create_presentation": {
        const p = await createPresentation(config.presentationsRoot, {
          name: str(args.name),
          title: args.title as string | undefined,
          theme: args.theme as string | undefined,
          install: args.install as boolean | undefined,
        });
        return json({ created: p });
      }

      case "start_server": {
        const p = await getPresentation(config.presentationsRoot, str(args.name));
        await ensureThemeInstalled(p);
        const running = await devServers.start(p, args.port as number | undefined);
        return json({ started: running, hint: `Open ${running.url} in a browser.` });
      }

      case "stop_server": {
        const stopped = await devServers.stop(str(args.name));
        return json({ stopped });
      }

      case "server_status":
        return json(devServers.list());

      case "select_presentation": {
        const p = await getPresentation(config.presentationsRoot, str(args.name));
        await ensureThemeInstalled(p);
        const tools = await proxy.connect(p);

        proxiedTools.clear();
        for (const t of tools) proxiedTools.set(proxiedName(t.name), t);

        // Notify spec-compliant clients (Claude Code >= 2.1.0, OpenCode, ...)
        await server.sendToolListChanged();

        return json({
          targeted: p.name,
          exposedTools: [...proxiedTools.keys()],
          note:
            "These tools operate on this presentation's slides.md via the official Slidev MCP. " +
            "If your client ignores tools/list_changed, use `call_slidev_tool` instead.",
        });
      }

      case "call_slidev_tool": {
        const result = await proxy.call(
          str(args.tool),
          args.args as Record<string, unknown> | undefined,
        );
        return result as CallToolResult;
      }

      default: {
        // Dynamically proxied slidev_* tool?
        const child = proxiedTools.get(name);
        if (child) {
          const result = await proxy.call(child.name, args as Record<string, unknown>);
          return result as CallToolResult;
        }
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Helpers & lifecycle
// ---------------------------------------------------------------------------

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function str(v: unknown): string {
  if (typeof v !== "string" || !v) throw new Error("Missing required string argument.");
  return v;
}

async function shutdown() {
  await Promise.allSettled([proxy.close(), devServers.stopAll()]);
  process.exit(0);
}
process.on("exit", () => {
  for (const s of devServers.list()) {
    try {
      process.kill(-s.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error("[slidev-orchestrator] fatal:", err);
  shutdown();
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel -> log to stderr only.
console.error(`[slidev-orchestrator] ready. Presentations root: ${config.presentationsRoot}`);
