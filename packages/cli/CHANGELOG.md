# @kaitox/cli

## 0.4.0

### Minor Changes

- 4043dc2: Harden `restart` and expose it through the main CLI. `kaitox relay restart` (new) and `kaitox-relay restart` now kill whatever holds the relay port — graceful pidfile SIGTERM first, then a port sweep via `lsof`/`netstat` that catches orphan processes whose pidfile is missing or stale (SIGTERM, then SIGKILL after a grace period) — before starting the daemon again. `@kaitox/relay` exports the sweep as `killPortOccupants()`.

### Patch Changes

- Updated dependencies [4043dc2]
- Updated dependencies [4043dc2]
- Updated dependencies [4043dc2]
- Updated dependencies [4043dc2]
  - @kaitox/x-article@0.5.0
  - @kaitox/relay@0.5.0

## 0.3.1

### Patch Changes

- Reposition Kaitox as a personal toolkit: the CLI, Obsidian plugin, Chrome extension, and agent skills are each one product of the toolkit, and X (Twitter) Article publishing is the first feature that cuts across them. READMEs, package descriptions, manifests, CLI help text, and architecture docs are reworded accordingly. The agent skill moved from `packages/cli/skills/` to the repo-root `skills/` directory (it no longer ships inside the `@kaitox/cli` npm tarball). Every README now ships in both English and Chinese (`README.md` + `README.zh-CN.md`), and the two apps gained READMEs of their own.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @kaitox/relay-protocol@0.4.0
  - @kaitox/relay@0.4.0
  - @kaitox/x-article@0.4.0
