import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PresentationInfo } from "./presentations.js";
import { slidevCommand } from "./servers.js";

/**
 * Manages the connection to the *official* Slidev MCP server
 * (`slidev mcp slides.md`) of the currently targeted presentation.
 *
 * Acts as an MCP client; the orchestrator re-exposes the discovered
 * tools to its own client (Claude Code, OpenCode, ...).
 */
export class SlidevProxy {
  private client: Client | null = null;
  private _target: PresentationInfo | null = null;
  private _tools: Tool[] = [];

  get target(): PresentationInfo | null {
    return this._target;
  }

  get tools(): Tool[] {
    return this._tools;
  }

  /** Connect to the `slidev mcp` of the given presentation (closing any previous one). */
  async connect(p: PresentationInfo): Promise<Tool[]> {
    await this.close();

    const { command, args } = slidevCommand(p);
    const transport = new StdioClientTransport({
      command,
      args: [...args, "mcp", "slides.md"],
      cwd: p.path,
      stderr: "ignore",
    });

    const client = new Client(
      { name: "slidev-orchestrator", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
    const { tools } = await client.listTools();

    this.client = client;
    this._target = p;
    this._tools = tools;
    return tools;
  }

  async call(toolName: string, args: Record<string, unknown> | undefined) {
    if (!this.client || !this._target) {
      throw new Error("No presentation targeted. Call `select_presentation` first.");
    }
    return this.client.callTool({ name: toolName, arguments: args ?? {} });
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* child already gone */
      }
    }
    this.client = null;
    this._target = null;
    this._tools = [];
  }
}

/** Prefix + sanitize a child tool name for re-exposure. */
export function proxiedName(childToolName: string): string {
  return `slidev_${childToolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
