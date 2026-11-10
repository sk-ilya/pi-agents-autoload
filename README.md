# pi-agents-autoload

Progressive discovery and loading of nested context files for [Pi](https://github.com/badlogic/pi-mono).

Pi loads instructions from the working directory and its ancestors at startup. This extension discovers nested `AGENTS.md` files as the agent works, loading only relevant instructions instead of including them all in the initial context.

Tested with Pi 1.5.2.

## Features

- **Automatic loading** - Inject instructions when the agent accesses files in nested directories.
- **Safe edits and writes** - Show new or changed instructions before a file is modified.
- **System-level delivery** - Deliver instructions as mid-conversation system messages on supported models.
- **Selective compaction carry-over** - Keep the most-used instructions after compaction, within a size limit.
- **Automatic refresh** - Pick up changed or deleted instructions on the next relevant access.

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

Reading `src/app.ts` loads `src/AGENTS.md`. Reading `tests/app.test.ts` loads `tests/AGENTS.md` separately. Applicable instructions from parent directories load first.

In each nested directory, the extension checks `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` in that order and loads the first one it finds.

If an edit or write finds new or changed instructions, it is blocked until the agent has seen them and retries. An unreadable applicable instruction file also blocks the change. Reading the selected instruction file directly does not add a second copy.

The extension checks for changes on later file accesses. By default, supported models receive new instructions as system messages after the access that found them; other models receive them in tool results. Earlier messages stay in place.

## Retention

Each successful file access adds a hit to the nested instructions it uses. At compaction, files with at least four hits can stay, most-used first, within a shared 50 KiB default limit. A nested file stays only if its managed parent instructions stay too.

Hits reset after compaction. Files that did not stay can load again on a later access. Pi's startup instructions are outside this limit.

## Configuration

The defaults work for most projects, so configuration is optional.

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

- `mode` chooses how instructions reach the agent. Default: `auto`. The modes are described below.
- `ignore` lists instruction paths to skip. Default: an empty list.
- `maxBytes` limits the combined size of instructions kept after compaction. Default: `51200` (50 KiB); `0` removes the limit.
- `maxFiles` limits how many instruction files are kept. Default: `0` (no limit).

A trusted project's settings override global settings one field at a time. A project `ignore` list replaces the global list rather than combining with it. Invalid configuration is reported as an extension error, and the session uses defaults.

### Delivery modes

| Mode        | Behavior                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `auto`      | Use system messages on supported models; otherwise use tool results.                           |
| `immediate` | Always use system messages. Cache reuse may suffer on models without mid-conversation support. |
| `deferred`  | Use tool results initially; retained instructions move to system messages after compaction.    |

### Ignore patterns

`ignore` patterns match project-relative instruction paths using Node's `path.matchesGlob()`. Ignoring one filename lets the next file in that directory's order be selected. A directory pattern skips instruction files throughout that directory.

Ignored files can still be read explicitly and do not block edits or writes. Ignoring a parent file does not ignore files in child directories. A configuration reload removes newly ignored files from active instructions. Pi's startup instructions are unaffected.

## Status

New or updated instructions produce a notification:

```text
Instructions loaded (~120 tokens):
  src/AGENTS.md
```

Use `/agents-md-status` to see loaded files, hit counts, the current mode, and what would survive compaction.

## Limitations

- Discovery works with Pi's built-in `read`, `edit`, and `write` tools, not shell commands, MCP, or custom tools.
- Only nested files inside the working directory are managed. Symlinks pointing outside it are ignored.
- Changes are checked on relevant file accesses, not continuously. A same-size rewrite with unchanged file timestamps may be missed.
- Recent tool results, explicit reads, quoted instructions, and compaction summaries may still show instructions even when a file is not carried over.

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
