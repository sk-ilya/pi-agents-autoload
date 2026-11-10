# pi-agents-autoload development

Pi extension that loads nested `AGENTS.md` files on demand. The
implementation lives in `src/`, split by responsibility (`index.ts` hook
wiring, `config.ts`, `discovery.ts`, `instructions.ts`, `delivery.ts`,
`status.ts`); tests in `tests/` run against a real `AgentSession` with a
scripted model.

- Node.js >= 22.20 (stable `path.matchesGlob`), no runtime dependencies.
- `npm run check` runs Biome, TypeScript, and Vitest; it must pass before
  committing.
- Target Pi 1.5.1 public APIs (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`); do not import private Pi internals.
- Try changes without installing: `pi -e ./src/index.ts`. Disable any installed
  copy first to avoid loading the extension twice.
- Compaction retains managed files with at least two successful access hits
  during the cycle, ranked within a shared 80 KiB default UTF-8 content budget;
  applicable managed parents must fit too. Selected files receive per-file
  system sections anchored after the compaction summary; unselected sections
  are omitted while Pi's recent tool-result history remains intact. Pi-native
  instructions are outside this budget. Access refreshes changed content and
  drops deleted files independently of compaction.
- Prefer small functions and explicit state transitions; avoid event buses,
  dependency injection, and other abstractions the code does not need.
