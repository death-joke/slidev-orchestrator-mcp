# slidev-orchestrator-mcp

Serveur MCP (TypeScript) pour orchestrer plusieurs présentations [Slidev](https://sli.dev) :

- lister les présentations d'un dossier racine (`mainfolder/presentation1`, `mainfolder/presentation2`, ...)
- créer une nouvelle présentation (scaffold + `npm install`)
- démarrer / arrêter / lister les serveurs de dev Slidev (allocation de ports automatique)
- **cibler** une présentation : le serveur se connecte au MCP officiel de Slidev
  (`slidev mcp slides.md`) de cette présentation et ré-expose dynamiquement ses tools
  (préfixés `slidev_*`) via `tools/list_changed`.

## Structure attendue

```
mainfolder/
├── presentation1/
│   ├── slides.md        <- requis (c'est ce qui identifie une présentation)
│   └── package.json     <- @slidev/cli en dépendance locale (recommandé)
└── presentation2/
    └── slides.md
```

## Installation

```bash
npm install
npm run build
```

## Configuration du dossier racine

Ordre de priorité :

1. Argument CLI : `--dir /chemin/vers/mainfolder` (ou `-d`, ou premier argument positionnel)
2. Variable d'environnement : `SLIDEV_PRESENTATIONS_DIR`

Optionnel : `SLIDEV_BASE_PORT` (défaut `3030`) — premier port essayé pour les dev servers.

## Intégration

### Claude Code

```bash
claude mcp add slidev-orchestrator -- node /chemin/vers/dist/index.js --dir /chemin/vers/mainfolder
```

ou avec la variable d'environnement :

```bash
claude mcp add slidev-orchestrator -e SLIDEV_PRESENTATIONS_DIR=/chemin/vers/mainfolder -- node /chemin/vers/dist/index.js
```

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "slidev-orchestrator": {
      "type": "local",
      "command": ["node", "/chemin/vers/dist/index.js"],
      "environment": { "SLIDEV_PRESENTATIONS_DIR": "/chemin/vers/mainfolder" }
    }
  }
}
```

## Tools exposés

| Tool                  | Description                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list_presentations`  | Liste les présentations (titre/thème lus dans le frontmatter, état du dev server, cible actuelle)                          |
| `create_presentation` | Scaffold `slides.md` + `package.json` + install (`name`, `title?`, `theme?`, `install?`)                                   |
| `start_server`        | Démarre `slidev --port N` pour une présentation, renvoie l'URL                                                             |
| `stop_server`         | Arrête le dev server d'une présentation                                                                                    |
| `server_status`       | Liste les dev servers en cours                                                                                             |
| `select_presentation` | Cible une présentation → spawn `slidev mcp slides.md`, ré-expose ses tools en `slidev_*` et envoie `tools/list_changed`    |
| `call_slidev_tool`    | Passthrough générique vers le MCP Slidev ciblé (fallback pour les clients qui ignorent `list_changed`, ex. Claude Desktop) |

## Notes

- Claude Code (>= 2.1.0) et OpenCode gèrent `tools/list_changed` : après `select_presentation`,
  les tools `slidev_*` apparaissent directement. Claude Desktop l'ignore : utiliser
  `call_slidev_tool` à la place.
- Le binaire Slidev local (`node_modules/.bin/slidev`) est préféré ; fallback
  `npx -y @slidev/cli` (le paquet s'appelle `@slidev/cli`, pas `slidev`).
- Tous les process enfants (dev servers + MCP Slidev) sont tués proprement à l'arrêt.
