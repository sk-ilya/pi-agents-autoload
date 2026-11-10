# pi-agents-autoload

Progressive `AGENTS.md` discovery and loading for [Pi](https://github.com/badlogic/pi-mono).

Pi loads instructions from the working directory and its ancestors at startup. This extension discovers nested `AGENTS.md` files as the agent works, loading only relevant instructions instead of including them all in the initial context.

## Features

- **Safe edits and writes** - Ensures applicable instructions reach the agent before file modifications, including parallel tool calls.
- **Model-aware delivery** - Uses system-prompt updates where supported, with a cache-friendly tool-result fallback.
- **Compaction-aware retention** - Preserves recently used instructions across compaction and expires inactive ones.
- **Automatic refresh** - Detects changed or deleted instructions on subsequent file accesses without redundant prompt updates.
- **Session persistence** - Restores instructions across session resumption and branch navigation.
- **Configurable exclusions** - Supports glob patterns to exclude selected instructions from automatic loading.

## Installation

Install from npm:

```sh
pi install npm:pi-agents-autoload
```

Or directly from GitHub:

```sh
pi install git:github.com/sk-ilya/pi-agents-autoload
```

Add `-l` for a project-local installation.

## How it works

```text
project/
├── AGENTS.md              # Loaded by Pi
├── src/
│   ├── AGENTS.md          # Loaded on demand
│   └── app.ts
└── tests/
    ├── AGENTS.md          # Loaded on demand
    └── app.test.ts
```

Reading `src/app.ts` loads `src/AGENTS.md`. Accessing `tests/app.test.ts` loads its instructions separately. Applicable instructions are loaded from parent to child, without duplicates.

If an edit or write encounters new or updated instructions, the operation is blocked until the agent receives them and can retry. If an applicable instruction file cannot be inspected, edits and writes stay blocked until access is restored. Reading an `AGENTS.md` file directly does not inject a second copy.

On each relevant access, the extension checks for instruction changes. Unchanged content produces no prompt update.

**Retention:** At each successful compaction, instructions used during the current cycle are retained and their usage is reset. Instructions unused throughout the following cycle expire at the next compaction. Accessing their directories again renews or rediscovers them.

## Configuration

Configuration is optional:

| Scope   | Path                                  |
| ------- | ------------------------------------- |
| Global  | `~/.pi/agent/pi-agents-autoload.json` |
| Project | `.pi/pi-agents-autoload.json`         |

Example:

```json
{
  "mode": "auto",
  "ignore": ["vendor/**", "**/generated/**", "docs/legacy/AGENTS.md"]
}
```

Each setting resolves independently: trusted project configuration overrides global configuration, which overrides the defaults (`mode: "auto"`, `ignore: []`). An empty project `ignore` array overrides the global list.

Invalid configuration is reported through Pi's extension errors, and the session falls back to defaults.

### Delivery modes

| Mode        | Behavior                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `auto`      | Use system-prompt updates when the model supports mid-conversation system messages; otherwise use tool results.        |
| `immediate` | Force system-prompt delivery. May cause prompt cache misses on models without mid-conversation system-message support. |
| `deferred`  | Initially deliver instructions through tool results, preserving the cached prompt prefix.                              |

Instructions delivered through tool results are promoted to the system prompt when retained across compaction.

### Ignore patterns

`ignore` accepts glob patterns matched against project-relative `AGENTS.md` paths, using Node's `path.matchesGlob()`.

Ignored instructions are not automatically loaded and do not block edits or writes. They can still be read explicitly. Ignoring a parent `AGENTS.md` does not exclude nested instruction files.

Configuration reloads also remove newly ignored instructions from the active state. Root and ancestor instructions loaded natively by Pi are unaffected.

## Status

New or updated instructions produce a notification:

```text
AGENTS.md loaded (~120 tokens):
  src/AGENTS.md
```

Use `/agents-md-status` to inspect active instruction files, delivery methods, approximate token counts, and the effective loading mode.

## Limitations

- Discovery operates through Pi's built-in `read`, `edit`, and `write` tools, not shell commands, MCP, or custom tools.
- Only nested instructions within the working directory are managed. Symlinks pointing outside it are ignored.
- Changes are detected on relevant file accesses, not continuously. Metadata-based checks may miss a same-size rewrite if file timestamps do not change.
- Expired or deleted instructions may still appear in retained conversation history or compaction summaries.

## Development

Requires Node.js 22.20 or newer.

```sh
npm ci
npm run check
pi -e ./src/index.ts
```

If the npm package is also configured, remove or disable it first; `-e` would load a second copy of the extension.

To run these checks before each commit, enable the tracked Git hook once per clone:

```sh
git config --local core.hooksPath .githooks
```

MIT licensed.
