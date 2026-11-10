# pi-agents-autoload

Progressive `AGENTS.md` discovery and loading for [Pi](https://github.com/badlogic/pi-mono).

Pi loads instructions from the working directory and its ancestors at startup. This extension discovers nested `AGENTS.md` files as the agent works, loading only relevant instructions instead of including them all in the initial context.

Tested with Pi 1.5.1.

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

If an edit or write encounters new or updated instructions, the operation is blocked until the agent receives them and can retry. If an applicable instruction file cannot be inspected, edits and writes stay blocked until access is restored. Reading an `AGENTS.md` file directly does not inject a second copy.

On each relevant access, the extension checks for instruction changes. Unchanged content produces no prompt update. System-delivered files have separate prompt sections, anchored after the discovering tool batch. Each subsequent request replays the same section changes at the same positions, so discovering another file leaves the cached prefix intact.

**Retention:** Successful file accesses count hits for applicable discovered managed `AGENTS.md` files, including their managed parents; a complete direct read also counts the instruction file itself. Failed operations do not count. At compaction, files with at least two hits compete by hit count for a shared 80 KiB UTF-8 content budget. A child is skipped unless its applicable managed parent is also selected. Ties favor shallower paths, then alphabetical paths. Unselected system sections are omitted from subsequent model requests, even when Pi's compaction checkpoint retains them. Pi's recent tool-result tail, including any previously injected instructions, stays intact; those instructions can remain visible until a later compaction. Hits reset after compaction; subsequent accesses can rediscover dropped files. Pi-loaded root and ancestor instructions are unaffected and do not use the budget.

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
  "maxBytes": 81920,
  "maxFiles": 0
}
```

Each setting resolves independently: trusted project configuration overrides global configuration, which overrides the defaults (`mode: "auto"`, `ignore: []`, `maxBytes: 81920`, `maxFiles: 0`). `maxBytes` caps the combined UTF-8 content of selected managed files; `maxFiles` caps their count. Both accept non-negative safe integers, with `0` meaning unlimited. An empty project `ignore` array overrides the global list.

Invalid configuration is reported through Pi's extension errors, and the session falls back to defaults.

### Delivery modes

| Mode        | Behavior                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`      | Use system-prompt updates when the model supports mid-conversation system messages; otherwise use tool results.                         |
| `immediate` | Force system-prompt delivery. Mid-run patches stay at a stable position; unsupported models may miss the cache when the prompt changes. |
| `deferred`  | Initially deliver instructions through tool results, preserving the cached prompt prefix.                                               |

Instructions delivered through tool results are promoted to the system prompt when retained across compaction. The extension persists section placement as session state and replays selected files at the compaction boundary; starting a new run does not move the patches. Earlier versions of changed instructions can remain in the append-only conversation until compaction.

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

Use `/agents-md-status` to inspect Pi-loaded and managed files, per-file hits, approximate token counts, measured managed bytes, and the effective loading mode. Managed files are grouped by which ones would receive system carry-over if compacted now; unselected files can still appear in Pi's recent tool-result history.

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
