# @kaitox/relay

## 0.5.0

### Minor Changes

- 4043dc2: Transparently re-encode oversized images at ingest. X's media upload rejects images over 5MB (`maxFileSizeExceeded`); the relay now fits them silently when drafts are saved (`POST /drafts`) or covers are set (`PUT /drafts/:id/cover`): opaque images become JPEG (white background, quality 90), images with transparency become WebP, stepping the dimensions down until the result fits. GIF/SVG and in-limit images pass through untouched, and any processing failure falls back to the original bytes. Bundle asset metadata (`mime`, `bytesLen`) reflects the stored bytes. Adds `sharp` as a dependency — the relay is no longer zero-dep.
- 4043dc2: Harden `restart` and expose it through the main CLI. `kaitox relay restart` (new) and `kaitox-relay restart` now kill whatever holds the relay port — graceful pidfile SIGTERM first, then a port sweep via `lsof`/`netstat` that catches orphan processes whose pidfile is missing or stale (SIGTERM, then SIGKILL after a grace period) — before starting the daemon again. `@kaitox/relay` exports the sweep as `killPortOccupants()`.

## 0.4.0

### Minor Changes

- Add cover upload: new `PUT /drafts/:id/cover` relay endpoint and `RelayClient.setCover()` (with `SetCoverInput` / `SetCoverWireBody` types). The Chrome extension's draft box uses it to set or replace a draft's cover image from the detail panel; the relay persists the bytes under `assets/cover-<fileName>` and updates `bundle.cover`.

### Patch Changes

- Fix `GET /drafts` losing uploaded drafts: `listDrafts()` now also scans the `sent/` directory, so drafts acked as `done` stay in the list (with `status: 'done'`) instead of vanishing. This is what the Chrome extension's 已上传 tab relies on; badge-style consumers that only want actionable drafts should keep filtering by `status !== 'done'`.
- Reposition Kaitox as a personal toolkit: the CLI, Obsidian plugin, Chrome extension, and agent skills are each one product of the toolkit, and X (Twitter) Article publishing is the first feature that cuts across them. READMEs, package descriptions, manifests, CLI help text, and architecture docs are reworded accordingly. The agent skill moved from `packages/cli/skills/` to the repo-root `skills/` directory (it no longer ships inside the `@kaitox/cli` npm tarball). Every README now ships in both English and Chinese (`README.md` + `README.zh-CN.md`), and the two apps gained READMEs of their own.
- Updated dependencies
- Updated dependencies
  - @kaitox/relay-protocol@0.4.0
