# pi-agents-autoload development

Pi extension that loads nested `AGENTS.md` files on demand. Single-file
implementation in `index.ts`; tests in `tests/` run against a real
`AgentSession` with a scripted model.

- Node.js >= 22.19, no runtime dependencies.
- `npm run check` runs Biome, TypeScript, and Vitest; it must pass before
  committing.
- Target Pi 1.5.0 public APIs (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`); do not import private Pi internals.
- Try changes without installing: `pi -e ./index.ts`.
- Nested instructions survive one compaction cycle of disuse: compaction
  retains files used during the cycle (promoting tool-result delivery to the
  `pi_agents_md` system section) and expires files that went a full cycle
  unused. File access renews a file and refreshes changed content on the
  first re-access after compaction.
- Keep the implementation in one file and prefer removing code over adding
  abstractions.
