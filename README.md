# slidev-orchestrator-mcp

MCP (TypeScript) server to orchestrate multiple [Slidev](https://sli.dev) presentations:

- list the presentations under a root folder (`mainfolder/presentation1`, `mainfolder/presentation2`, ...)
- create a new presentation (scaffold + `npm install`)
- start / stop / list Slidev dev servers (automatic port allocation)
- **target** a presentation: the server connects to that presentation's official Slidev MCP
  (`slidev mcp slides.md`) and dynamically re-exposes its tools (prefixed `slidev_*`) via
  `tools/list_changed`.

## Expected structure

```
mainfolder/
├── presentation1/
│   ├── slides.md        <- required (this is what identifies a presentation)
│   └── package.json     <- @slidev/cli as a local dependency (recommended)
└── presentation2/
    └── slides.md
```

## Installation

The package is published on npm as [`slidev-orchestrator-mcp`](https://www.npmjs.com/package/slidev-orchestrator-mcp),
so no local clone or build is required — just run it with `npx`.

## Root folder configuration

Priority order:

1. CLI argument: `--dir /path/to/mainfolder` (or `-d`, or the first positional argument)
2. Environment variable: `SLIDEV_PRESENTATIONS_DIR`

Optional: `SLIDEV_BASE_PORT` (default `3030`) — first port tried for dev servers.

## Integration

### Claude Code

```bash
claude mcp add slidev-orchestrator -- npx -y slidev-orchestrator-mcp --dir /path/to/mainfolder
```

or with the environment variable:

```bash
claude mcp add slidev-orchestrator -e SLIDEV_PRESENTATIONS_DIR=/path/to/mainfolder -- npx -y slidev-orchestrator-mcp
```

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "slidev-orchestrator": {
      "type": "local",
      "command": ["npx", "-y", "slidev-orchestrator-mcp"],
      "environment": { "SLIDEV_PRESENTATIONS_DIR": "/path/to/mainfolder" }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "slidev-orchestrator": {
      "command": "npx",
      "args": ["-y", "slidev-orchestrator-mcp", "--dir", "/path/to/mainfolder"]
    }
  }
}
```

## Exposed tools

| Tool                  | Description                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `list_presentations`  | List presentations (title/theme read from frontmatter, dev server status, current target)                                |
| `create_presentation` | Scaffold `slides.md` + `package.json` + install (`name`, `title?`, `theme?`, `install?`)                                 |
| `start_server`        | Start `slidev --port N` for a presentation, returns the URL                                                              |
| `stop_server`         | Stop a presentation's dev server                                                                                         |
| `server_status`       | List running dev servers                                                                                                 |
| `select_presentation` | Target a presentation → spawns `slidev mcp slides.md`, re-exposes its tools as `slidev_*` and sends `tools/list_changed` |
| `call_slidev_tool`    | Generic passthrough to the targeted Slidev MCP (fallback for clients that ignore `list_changed`, e.g. Claude Desktop)    |

## Notes

- Claude Code (>= 2.1.0) and OpenCode support `tools/list_changed`: after `select_presentation`,
  the `slidev_*` tools appear directly. Claude Desktop ignores it: use `call_slidev_tool` instead.
- The presentation's local Slidev binary (`node_modules/.bin/slidev`) is preferred; falls back to
  `npx -y @slidev/cli` (the package is named `@slidev/cli`, not `slidev`).
- All child processes (dev servers + Slidev MCP) are cleanly killed on shutdown.

## Development

To work on the server itself (not just use it):

```bash
git clone https://github.com/death-joke/slidev-orchestrator-mcp.git
cd slidev-orchestrator-mcp
npm install
npm run build
node dist/index.js --dir /path/to/mainfolder
```

See `CLAUDE.md` for the full architecture overview and contribution guidelines.
