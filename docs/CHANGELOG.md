# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Default bind address is now the auto-detected LAN IPv4 instead of `0.0.0.0`,
  so the service is only reachable from the local network out of the box.
- Memory panel redesigned: files are grouped by project slug (with a "Global"
  group for top-level files), each group is collapsible with state persisted
  to `localStorage`, and entries are sorted by modification time. Items now
  reuse the session-item visual style and show filename + subpath / size /
  relative time.
- `GET /api/memory` now returns `size` and `mtime` for each file.

### Added
- English README (`README.en.md`) alongside the existing Chinese README.
- `.env.example` template for environment variables.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- GitHub issue / PR templates and basic CI workflow.
- Edit and delete memory files from the Memory tab
  (`PUT /api/memory/file` and `DELETE /api/memory/file`).

## [1.0.0] - 2026-04-13

### Added
- Initial public release.
- Multi-session management, WebSocket streaming, session persistence.
- MCP-based interactive permission approval.
- Memory file browser and dark theme UI.
