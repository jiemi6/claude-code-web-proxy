# Contributing to claude-code-web-proxy

Thanks for your interest in contributing! This document explains how to report issues, propose changes, and submit pull requests.

> 语言 / Languages: English only for this document — issues and PRs may be written in English or 中文.

## Reporting issues

Before opening an issue, please:

1. Search [existing issues](../../issues) to avoid duplicates.
2. Check that you are running the latest `master` branch.
3. Include the following in your report:
   - Node.js version (`node --version`)
   - Claude Code CLI version (`claude --version`)
   - OS and version
   - Steps to reproduce
   - Expected vs. actual behavior
   - Relevant excerpts from `app.log`

Use the provided issue templates when available.

## Proposing changes

For non-trivial changes, please open an issue first to discuss the approach. This avoids wasted work if the change doesn't fit the project's direction.

Small fixes (typos, obvious bugs, doc improvements) can go straight to a pull request.

## Development setup

```bash
git clone <your-fork-url> claude-code-web-proxy
cd claude-code-web-proxy
npm install
npm run dev    # auto-reload on file changes
```

The project has a single runtime dependency (`ws`). There is currently no build step, linter, or test suite — keep changes small and readable.

## Pull request guidelines

- **Scope**: one logical change per PR. Don't bundle unrelated fixes.
- **Commits**: prefer clear, descriptive commit messages. Squashing is fine.
- **Style**: match the surrounding code. The backend uses plain Node.js with no framework; the frontend is a single HTML file with vanilla JS.
- **Compatibility**: the project targets Node.js 18+. Avoid adding dependencies unless absolutely necessary.
- **Security**: this project executes local shell commands via the Claude CLI. Be extra careful with any code that touches `child_process`, file paths, or WebSocket message parsing.
- **Docs**: update `README.md`, `README.en.md`, and `API.md` when you change user-facing behavior.
- **Test it manually**: spin up the server, create a session, and verify your change end-to-end before requesting review.

## Code of Conduct

By participating in this project you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](../LICENSE)).
