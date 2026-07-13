# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server, written in TypeScript, that orchestrates multiple [Slidev](https://sli.dev) presentations living as sibling folders under one root directory. It is a stdio MCP server (`dist/index.js`) intended to be registered with MCP clients like Claude Code or OpenCode.

## Commands

```bash
npm run build       # tsc -> dist/, then chmod +x dist/index.js
npm run dev          # tsc --watch
npm run lint         # eslint .
npm run lint:fix     # eslint . --fix
npm run format       # prettier --write .
npm run format:check # prettier --check .
```

There is no test suite (`npm test` is a stub that exits non-zero). Verify changes by building and manually driving the server (see "Manual testing" below).

Run the built server directly:

```bash
node dist/index.js --dir /path/to/presentations-root
# or
SLIDEV_PRESENTATIONS_DIR=/path/to/presentations-root node dist/index.js
```

### Git hooks (husky)

- `pre-commit` runs `lint-staged`: `eslint --fix` + `prettier --write` on staged `*.ts/*.js`, `prettier --write` on staged `*.json/*.md`.
- `commit-msg` runs `commitlint` (conventional-commits style, via `@commitlint/config-conventional`) — commit messages must follow the conventional commits format (`feat:`, `fix:`, `chore:`, etc.).
- `npm run release` uses `commit-and-tag-version` to bump the version/changelog from commit history — don't hand-edit version numbers.

## Architecture

The server has exactly two categories of tools it exposes over MCP, and understanding the split is key to working in this codebase:

1. **Static "management" tools** — always present, defined as a fixed array in `src/index.ts` (`MANAGEMENT_TOOLS`): `list_presentations`, `create_presentation`, `start_server`, `stop_server`, `server_status`, `select_presentation`, `call_slidev_tool`.
2. **Dynamic proxied tools** — appear only after `select_presentation` targets a presentation. The orchestrator spawns the presentation's own `slidev mcp slides.md` process, lists its tools, and re-exposes each one prefixed `slidev_*` (see `proxiedName` in `src/slidev-proxy.ts`). It then calls `server.sendToolListChanged()` so MCP clients that support `tools/list_changed` (Claude Code ≥ 2.1.0, OpenCode) pick up the new tools automatically. Clients that don't support it (e.g. Claude Desktop) must fall back to the generic `call_slidev_tool` passthrough.

Selecting a new presentation replaces the previous target; only one presentation can be "selected"/proxied at a time (`proxiedTools` map in `src/index.ts` is cleared and rebuilt on each `select_presentation` call).

### Module responsibilities

- **`src/index.ts`** — the MCP server entry point. Wires config, `DevServerManager`, and `SlidevProxy` together; declares the static tool schemas; routes `CallToolRequestSchema` to the right handler; owns process lifecycle (SIGINT/SIGTERM/uncaughtException all trigger `shutdown()`, which stops dev servers and closes the proxy). stdout is reserved for the MCP protocol channel — all logging must go to `console.error` (stderr), never `console.log`.
- **`src/config.ts`** — resolves the presentations root directory and base port. Priority: `--dir`/`-d` CLI flag (or first positional arg) → `SLIDEV_PRESENTATIONS_DIR` env var. Fails fast if neither is set or the path doesn't exist. `basePort` comes from `SLIDEV_BASE_PORT` (default `3030`).
- **`src/presentations.ts`** — filesystem-level presentation discovery and scaffolding. A folder counts as a presentation iff it directly contains a `slides.md` (see `listPresentations`). `createPresentation` scaffolds `slides.md` + `package.json` + `.gitignore` and optionally runs `npm install`. `ensureThemeInstalled` lazily installs the theme package (`@slidev/theme-<name>`, or the raw string if it looks like a package name/path) before starting a server.
- **`src/servers.ts`** — `DevServerManager` spawns/tracks Slidev dev server child processes (`slidev slides.md --port N --remote`), one per presentation, keyed by presentation name. Key details:
  - Prefers the presentation's local `node_modules/.bin/slidev`; falls back to `npx -y @slidev/cli` (`slidevCommand`, shared with `slidev-proxy.ts`).
  - Ports are auto-allocated starting at `basePort`, scanning for a free one (`freePort`/`portAvailable`).
  - On POSIX, children are spawned `detached: true` so they own their own process group; `killTree` sends `SIGTERM` then `SIGKILL` to the whole group (`-pid`) to reliably kill Slidev's own child processes. Windows falls back to `child.kill()`.
  - `waitReady` polls `http://localhost:<port>` before returning from `start()`, and kills the process on timeout.
- **`src/slidev-proxy.ts`** — `SlidevProxy` is an MCP _client_ (not server) that connects to the official Slidev MCP (`slidev mcp slides.md`) of the currently targeted presentation via stdio, using the same `slidevCommand` resolution as `servers.ts`. `index.ts` uses this client's tool list to build the dynamic `slidev_*` proxy tools and forwards `call_slidev_tool`/`slidev_*` invocations through `SlidevProxy.call`.

### Process cleanup invariant

Every spawned child process (dev servers in `servers.ts`, the `slidev mcp` client process in `slidev-proxy.ts`) must be killed when the orchestrator exits or when a presentation is deselected/reselected. `shutdown()` in `index.ts` and the `process.on("exit", ...)` handler are the last line of defense — if you add new child processes, make sure they're tracked somewhere reachable from shutdown.

## Manual testing

Since there's no automated test suite, changes to tool behavior should be exercised end-to-end: build, register the server with an MCP client (or drive it directly over stdio), and call the tools against a real presentations root (a folder containing at least one sub-folder with a `slides.md`). Pay particular attention to:

- `create_presentation` → `start_server` → `select_presentation` → a `slidev_*` tool call → `stop_server`, in sequence.
- That killing the orchestrator process also kills any dev servers and the proxied `slidev mcp` child (no orphaned Slidev processes left behind).
