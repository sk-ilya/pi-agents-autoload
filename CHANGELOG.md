# Changelog

## [0.1.3] - 2026-11-10

### Added

- Support nested `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` files, selecting one instruction file per directory in Pi's filename order.

### Changed

- Switch to the next eligible file on relevant access when a selected file is removed or ignored, and select a newly available higher-priority file.
- Apply direct-read handling, edit safety, session restoration, and compaction parent selection to every supported filename.

## [0.1.2] - 2026-11-10

### Changed

- Compaction now carries over managed instructions with at least four hits, ranked within a shared 50 KiB default budget. Nested instructions must be retained with their managed parents.
- The minimum Node.js version is 22.20. Development checks target Pi 1.5.2.

### Added

- Optional `ignore`, `maxBytes`, and `maxFiles` settings.
- Hit counts and a carry-over preview in `/agents-md-status`.

### Fixed

- Keep system-delivered instructions at stable positions as more files are discovered, including across resume and compaction.
- Refresh changed or deleted instructions on relevant file access, and block edits and writes until new or changed instructions are available to the agent.
