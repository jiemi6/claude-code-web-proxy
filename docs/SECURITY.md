# Security Policy

## Threat model

claude-code-web-proxy runs the **Claude Code CLI** as a subprocess and exposes it over HTTP/WebSocket. Depending on the configured permission mode, the proxy can:

- Execute arbitrary shell commands on the host machine
- Read, write, and delete files within the session's working directory
- Access any resources reachable by the user running the server

**Anyone who can reach the HTTP port effectively has shell access to the host.** Treat the listening port as a privileged interface.

### Safe defaults

- The server binds to the machine's **LAN IPv4** by default — not `0.0.0.0`. It is not reachable from the public internet out of the box.
- The server has **no built-in authentication**. Do not expose it to untrusted networks.
- Running with `permissionMode: bypassPermissions` disables all safety checks inside Claude Code. Only use this on trusted networks and working directories.

### Recommendations for operators

- Run the server as an unprivileged user, never as `root`.
- Keep the service on a trusted LAN or behind a VPN / reverse proxy with authentication (e.g. basic auth, OAuth2, Tailscale).
- If you must expose it publicly, put it behind an authenticating reverse proxy and use the strictest permission mode that still meets your needs.
- Scope each session's working directory to a specific project — do not set it to `/` or your home directory.
- Review `app.log` periodically for unexpected activity.

## Supported versions

Only the latest `master` branch is supported. Security fixes will be applied to `master` and cut into a new release.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report them privately via one of the following channels:

- GitHub's [private vulnerability reporting](https://github.com/jiemi6/claude-code-web-proxy/security/advisories/new) (preferred)
- Email: <minkey611@gmail.com>

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions / commit hashes
- Any suggested mitigation

We aim to acknowledge reports within **72 hours** and provide an initial assessment within **7 days**. Once a fix is ready, we will coordinate disclosure with the reporter.
