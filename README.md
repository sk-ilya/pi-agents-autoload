# pi-agents-autoload

Progressive `AGENTS.md` discovery and loading for [Pi](https://github.com/badlogic/pi-mono).

Pi loads instructions from the working directory and its ancestors at startup. This extension discovers nested `AGENTS.md` files as the agent works, loading only relevant instructions instead of including them all in the initial context.

Tested with Pi 1.5.2.

## Features

- **Safe edits and writes** - Ensures applicable instructions reach the agent before file modifications, including parallel tool calls.
- **Model-aware delivery** - Uses system-prompt updates where supported, with a cache-friendly tool-result fallback.
- **Selective compaction carry-over** - Keeps frequently accessed instructions within a shared content budget.
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

If an edit or write uncovers new or changed instructions, the agent sees them before it can retry. If an applicable instruction file cannot be read, the edit or write remains blocked. Reading an `AGENTS.md` file directly does not load a second copy.

The extension checks for changes when a relevant file is accessed and leaves the prompt alone when instructions are unchanged. On supported models, new instructions appear after the access that found them, preserving the earlier conversation for prompt caching.

**Retention:** Successful file accesses add hits to the instructions they use.

At compaction, instructions with at least four hits may stay in the prompt. By default, the extension keeps the most-used files within a shared 50 KiB limit. Nested files must be kept with their managed parents; Pi's own startup instructions are outside the limit. Hits reset after compaction, and dropped files can be loaded again on a later access.

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
  "ignore": ["vendor/**", "**/generated/**", "docs/legacy/AGENTS.md"],
  "maxBytes": 51200,
  "maxFiles": 0
}
```

Each setting resolves independently: trusted project configuration overrides global configuration, which overrides the defaults (`mode: "auto"`, `ignore: []`, `maxBytes: 51200`, `maxFiles: 0`). `maxBytes` caps the combined UTF-8 content of selected managed files; `maxFiles` caps their count. Both accept non-negative safe integers, with `0` meaning unlimited. An empty project `ignore` array overrides the global list.

Invalid configuration is reported through Pi's extension errors, and the session falls back to defaults.

### Delivery modes

| Mode        | Behavior                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `auto`      | Use system messages on supported models; otherwise use tool results.                           |
| `immediate` | Always use system messages. Cache reuse may suffer on models without mid-conversation support. |
| `deferred`  | Use tool results initially; retained instructions move to system messages after compaction.    |

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

Use `/agents-md-status` to see loaded files, hit counts, the current mode, and what would survive compaction.

## Limitations

- Discovery operates through Pi's built-in `read`, `edit`, and `write` tools, not shell commands, MCP, or custom tools.
- Only nested instructions within the working directory are managed. Symlinks pointing outside it are ignored.
- Changes are detected on relevant file accesses, not continuously. Metadata-based checks may miss a same-size rewrite if file timestamps do not change.
- Recent tool results, explicit reads of `AGENTS.md`, quoted instructions, and compaction summaries can remain model-visible even when a file is not selected for system carry-over.

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
