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
- Nested instructions survive one compaction cycle of disuse: compaction
  retains files used during the cycle (promoting tool-result delivery to the
  `pi_agents_md` system section) and expires files that went a full cycle
  unused. File access renews a file; changed content is refreshed and deleted files
  dropped on the next relevant access, independent of compaction.
- Prefer small functions and explicit state transitions; avoid event buses,
  dependency injection, and other abstractions the code does not need.
