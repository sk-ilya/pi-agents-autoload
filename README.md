# pi-agents-autoload

Progressive `AGENTS.md` discovery and loading for [Pi](https://github.com/badlogic/pi-mono).

Pi normally loads instructions from the working directory and its ancestors at startup. This extension automatically discovers nested `AGENTS.md` files as the agent works, loading relevant instructions on demand instead of including every directory's instructions in the initial context.

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

When Pi reads `src/app.ts`, the extension discovers `src/AGENTS.md` and adds its instructions to the context. Accessing `tests/app.test.ts` loads `tests/AGENTS.md` separately.

If Pi attempts to edit or write a file before receiving its applicable instructions, the operation is blocked so the agent can retry with them loaded.

Instructions are deduplicated and remain active across compaction. At each compaction, instructions used since the previous compaction are retained; those unused for a full cycle expire. Accessing files in their directories renews them.

## Configuration

Configuration is optional. Create `pi-agents-autoload.json` in either location:

| Scope   | Path                                  |
| ------- | ------------------------------------- |
| Global  | `~/.pi/agent/pi-agents-autoload.json` |
| Project | `.pi/pi-agents-autoload.json`         |

Project settings override global settings and require a trusted project. The default mode is `auto`.

```json
{
  "mode": "auto"
}
```

| Mode        | Behavior                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `auto`      | Use system-prompt updates when the model supports mid-conversation system messages; otherwise use tool results. |
| `immediate` | Always update the system prompt, potentially invalidating the prompt cache.                                     |
| `deferred`  | Initially append instructions to tool results, preserving the cached prompt prefix.                             |

Instructions initially delivered through tool results are promoted to the system prompt when retained across compaction.

## Status

Pi displays a notification when new instructions are loaded:

```text
AGENTS.md loaded (~120 tokens):
  src/AGENTS.md
```

Use `/agents-md-status` to view all active instruction files, their delivery methods, approximate token counts, and the current model's loading mode.

## Limitations

- Detects file access through Pi's built-in `read`, `edit`, and `write` tools, not shell commands, MCP, or custom tools.
- Only loads nested `AGENTS.md` files within the working directory. Symlinks to instruction files outside it are ignored.
- Instruction changes are picked up on first re-access after compaction, not continuously monitored.
- Expired instructions may still be referenced in retained conversation messages or compaction summaries.

## Development

Requires Node.js 22.19 or newer.

```sh
npm ci
npm run check
pi -e ./index.ts
```

MIT licensed.
