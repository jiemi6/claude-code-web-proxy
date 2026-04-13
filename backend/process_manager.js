/**
 * ProcessManager - runs Claude Code commands per session.
 *
 * Each user message spawns:
 *   claude -p "prompt" --session-id UUID --output-format stream-json --verbose [--permission-mode ...]
 *
 * Permission handling modes:
 *   - "bypassPermissions": skip all checks (fast, no prompts)
 *   - "acceptEdits": auto-accept file edits, prompt for dangerous ops
 *   - "default": standard mode (will fail on permission needs unless MCP permission server is used)
 *   - "mcp": use MCP permission server → prompts forwarded to web UI
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events");
const { createPermissionServer } = require("./permission_mcp");

// Resolve claude binary
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {}
  const candidates = [
    path.join(process.env.HOME || "", ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}

const CLAUDE_BIN = findClaude();

function log(sid, ...args) {
  const tag = `[${new Date().toISOString()}] [${sid.slice(0, 8)}]`;
  console.log(tag, ...args);
}

/**
 * SessionRunner manages running claude commands for one session.
 * Ensures only one command runs at a time, queues the rest.
 */
class SessionRunner extends EventEmitter {
  constructor(sessionId, workingDir, permissionMode = "bypassPermissions") {
    super();
    this.sessionId = sessionId;
    this.workingDir = workingDir;
    this.permissionMode = permissionMode;
    this.proc = null;
    this.busy = false;
    this.queue = [];
    this.mcpServer = null;
    this.firstRun = true; // true = use --session-id (create), false = use --resume (continue)

    // Ensure cwd exists
    if (!fs.existsSync(this.workingDir)) {
      try {
        fs.mkdirSync(this.workingDir, { recursive: true });
        log(sessionId, `Created working dir: ${this.workingDir}`);
      } catch {
        this.workingDir = process.env.HOME || "/tmp";
        log(sessionId, `Fallback working dir: ${this.workingDir}`);
      }
    }

    // Start MCP permission server if needed
    if (this.permissionMode === "mcp") {
      this._startMcpServer();
    }
  }

  _startMcpServer() {
    if (this.mcpServer) return;
    this.mcpServer = createPermissionServer(this.sessionId, (req) => {
      log(this.sessionId, `Permission request: tool=${req.toolName} desc="${req.description || ""}"`);
      this.emit("permission_request", req);
    });
    log(this.sessionId, `MCP permission server started`);
  }

  /**
   * Handle permission response from web UI.
   */
  respondToPermission(requestId, allowed, reason) {
    if (!this.mcpServer) return false;
    const ok = this.mcpServer.respondToPermission(requestId, allowed, reason);
    log(this.sessionId, `Permission response: id=${requestId.slice(0, 8)} allowed=${allowed}`);
    return ok;
  }

  /**
   * Send a prompt. If busy, queues it.
   * @param {string} prompt
   * @param {Array} images - [{ media_type, data }] base64 images
   */
  send(prompt, images = []) {
    if (this.busy) {
      log(this.sessionId, `Busy, queuing message (queue size: ${this.queue.length + 1})`);
      this.queue.push({ prompt, images });
      this.emit("queued", this.queue.length);
      return;
    }
    this._run(prompt, images);
  }

  /**
   * Abort the current running command.
   */
  abort() {
    if (this.proc) {
      log(this.sessionId, "Aborting current command");
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        try { this.proc?.kill("SIGKILL"); } catch {}
      }, 3000);
    }
    this.queue = [];
  }

  _run(prompt, images = []) {
    this.busy = true;
    this.emit("busy", true);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Save images to temp files and build @references
    const tempFiles = [];
    let fullPrompt = prompt;
    if (images && images.length > 0) {
      const refs = [];
      for (const img of images) {
        const ext = (img.media_type || "image/png").split("/")[1] || "png";
        const tmpPath = path.join(os.tmpdir(), `claude-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
        tempFiles.push(tmpPath);
        refs.push(`@${tmpPath}`);
      }
      fullPrompt = refs.join(" ") + (prompt ? " " + prompt : "");
      log(this.sessionId, `Attached ${images.length} image(s)`);
    }

    const args = ["-p", fullPrompt];

    // First message: --session-id creates the session
    // Subsequent messages: --resume continues the existing session
    if (this.firstRun) {
      args.push("--session-id", this.sessionId);
    } else {
      args.push("--resume", this.sessionId);
    }

    args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");

    // Permission handling
    if (this.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    } else if (this.permissionMode === "acceptEdits") {
      args.push("--permission-mode", "acceptEdits");
    } else if (this.permissionMode === "auto") {
      args.push("--permission-mode", "auto");
    } else if (this.permissionMode === "mcp" && this.mcpServer) {
      // Use MCP permission server
      const mcpConfig = {
        mcpServers: {
          "web-proxy-permissions": {
            command: "node",
            args: ["-e", `
              // Connect to the existing MCP socket
              const net = require('net');
              const conn = net.connect('${this.mcpServer.socketPath}');
              process.stdin.pipe(conn);
              conn.pipe(process.stdout);
              conn.on('close', () => process.exit(0));
            `],
          },
        },
      };
      args.push("--permission-prompt-tool", "mcp__web-proxy-permissions__web_proxy_permission");
      args.push("--mcp-config", JSON.stringify(mcpConfig));
    }

    log(this.sessionId, `Running: claude -p "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}" mode=${this.permissionMode}`);

    try {
      this.proc = spawn(CLAUDE_BIN, args, {
        cwd: this.workingDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      log(this.sessionId, `Spawn error: ${err.message}`);
      this.emit("error", `Failed to start claude: ${err.message}`);
      this._finish();
      return;
    }

    let stdoutBuf = "";
    const textParts = [];

    this.proc.stdout.on("data", (chunk) => {
      const raw = chunk.toString("utf-8");
      log(this.sessionId, `stdout chunk (${raw.length} bytes)`);
      stdoutBuf += raw;

      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          this._handleEvent(event, textParts);
        } catch {
          log(this.sessionId, `Non-JSON stdout: ${trimmed.slice(0, 200)}`);
          textParts.push(trimmed);
          this.emit("text", trimmed);
        }
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        log(this.sessionId, `stderr: ${text.slice(0, 300)}`);
        this.emit("stderr", text);
      }
    });

    this.proc.on("error", (err) => {
      log(this.sessionId, `Process error: ${err.message}`);
      this.emit("error", err.message);
      this._finish();
    });

    this.proc.on("close", (code, signal) => {
      log(this.sessionId, `Process exited (code=${code}, signal=${signal})`);

      // Flush remaining buffer
      if (stdoutBuf.trim()) {
        try {
          const event = JSON.parse(stdoutBuf.trim());
          this._handleEvent(event, textParts);
        } catch {
          textParts.push(stdoutBuf.trim());
          this.emit("text", stdoutBuf.trim());
        }
      }

      const fullText = textParts.join("");
      this.emit("response_complete", fullText);

      // Cleanup temp image files
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch {}
      }

      // Mark session as initialized on successful exit
      if (code === 0) {
        this.firstRun = false;
      }

      if (code !== 0 && code !== null) {
        this.emit("error", `Claude exited with code ${code}`);
      }

      this._finish();
    });

    this.proc.stdin.end();
  }

  _finish() {
    this.proc = null;
    this.busy = false;
    this.emit("busy", false);
    this.emit("done");

    // Process next queued message
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      log(this.sessionId, `Processing queued message (${this.queue.length} remaining)`);
      this._run(next.prompt, next.images);
    }
  }

  _handleEvent(event, parts) {
    const type = event.type || "";
    log(this.sessionId, `Event: ${type}${event.subtype ? "/" + event.subtype : ""}`);

    switch (type) {
      case "system":
        if (event.subtype === "init") {
          log(this.sessionId, `Init: model=${event.model}, permMode=${event.permissionMode}, tools=${event.tools?.length || 0}`);
          this.emit("system_init", event);
        } else {
          this.emit("system_event", event);
        }
        break;

      case "assistant": {
        const msg = event.message || {};
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text") {
              const t = block.text || "";
              parts.push(t);
              this.emit("delta", t);
            } else if (block.type === "tool_use") {
              this.emit("tool_use", {
                id: block.id,
                name: block.name,
                input: block.input,
              });
            }
          }
        }
        break;
      }

      case "content_block_start": {
        const block = event.content_block || {};
        if (block.type === "text" && block.text) {
          parts.push(block.text);
          this.emit("delta", block.text);
        } else if (block.type === "tool_use") {
          this.emit("tool_use_start", {
            id: block.id,
            name: block.name,
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta || {};
        if (delta.type === "text_delta") {
          const t = delta.text || "";
          parts.push(t);
          this.emit("delta", t);
        }
        break;
      }

      case "result":
        // Always emit the final result text - it's the definitive answer
        if (event.result) {
          this.emit("result_text", event.result);
          // If no deltas were captured, also add to parts for response_complete
          if (parts.length === 0) {
            parts.push(event.result);
          }
        }
        const meta = {};
        for (const key of [
          "cost_usd", "total_cost_usd", "duration_ms", "duration_api_ms",
          "num_turns", "session_id", "is_error", "stop_reason",
        ]) {
          if (event[key] !== undefined) meta[key] = event[key];
        }
        log(this.sessionId, `Result: cost=$${meta.total_cost_usd || meta.cost_usd || "?"}, duration=${meta.duration_ms || "?"}ms, turns=${meta.num_turns || "?"}`);
        this.emit("result_meta", meta);
        break;

      case "rate_limit_event":
        log(this.sessionId, `Rate limit: ${event.rate_limit_info?.status}`);
        break;

      default:
        this.emit("raw_event", event);
        break;
    }
  }

  destroy() {
    this.abort();
    if (this.mcpServer) {
      this.mcpServer.close();
      this.mcpServer = null;
    }
    this.removeAllListeners();
  }
}

class ProcessManager {
  constructor() {
    /** @type {Map<string, SessionRunner>} */
    this.runners = new Map();
  }

  getOrCreate(sessionId, workingDir, permissionMode, hasHistory = false) {
    let runner = this.runners.get(sessionId);
    if (runner) return runner;

    runner = new SessionRunner(sessionId, workingDir, permissionMode);
    // If the session already has message history (e.g. server restarted),
    // it was already created in Claude - use --resume for next call
    if (hasHistory) {
      runner.firstRun = false;
    }
    this.runners.set(sessionId, runner);
    log(sessionId, `Runner created (cwd: ${workingDir}, permMode: ${permissionMode}, resume: ${hasHistory})`);
    return runner;
  }

  get(sessionId) {
    return this.runners.get(sessionId) || null;
  }

  abort(sessionId) {
    const runner = this.runners.get(sessionId);
    if (runner) runner.abort();
  }

  remove(sessionId) {
    const runner = this.runners.get(sessionId);
    if (runner) {
      runner.destroy();
      this.runners.delete(sessionId);
    }
  }

  killAll() {
    for (const [id, runner] of this.runners) {
      runner.destroy();
    }
    this.runners.clear();
  }

  status() {
    const result = [];
    for (const [id, runner] of this.runners) {
      result.push({
        sessionId: id,
        busy: runner.busy,
        queueLength: runner.queue.length,
        permissionMode: runner.permissionMode,
      });
    }
    return result;
  }
}

console.log(`Claude binary: ${CLAUDE_BIN}`);

module.exports = { ProcessManager, SessionRunner, claudeBin: CLAUDE_BIN };
