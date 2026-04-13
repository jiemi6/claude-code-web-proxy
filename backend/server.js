/**
 * claude-code-web-proxy - Node.js Backend
 *
 * Architecture:
 *   - Each user message runs: claude -p "prompt" --session-id UUID --output-format stream-json --verbose
 *   - Claude Code's --session-id maintains context across invocations
 *   - Only one command per session at a time (queued if busy)
 *   - WebSocket bridges browser to Claude's output stream
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");
const SessionManager = require("./session_manager");
const { ProcessManager, claudeBin: CLAUDE_BIN } = require("./process_manager");

/**
 * Detect the primary LAN IPv4 address (first non-internal IPv4 interface).
 * Falls back to 127.0.0.1 if no LAN interface is found.
 * Used as the default bind address so the service is reachable from the LAN
 * but not from public interfaces via 0.0.0.0.
 */
function detectLanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

const PORT = parseInt(process.env.PORT || "8199", 10);
const HOST = process.env.HOST || detectLanAddress();
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const MEMORY_DIR = path.join(process.env.HOME || "/home", ".claude");
const CLAUDE_PROJECTS_DIR = path.join(MEMORY_DIR, "projects");

const sessions = new SessionManager();
const procs = new ProcessManager();

// ─── Slash commands cache ─────────────────────────────────────────────────────

let cachedSlashCommands = null; // { slashCommands: [], skills: [] }

function probeSlashCommands() {
  const { spawn } = require("child_process");
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn(CLAUDE_BIN, [
    "-p", "hi",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ], { env, stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    // Parse first line (system init) as soon as we get it
    const idx = buf.indexOf("\n");
    if (idx >= 0) {
      try {
        const d = JSON.parse(buf.slice(0, idx).trim());
        if (d.type === "system" && d.subtype === "init" && d.slash_commands) {
          cachedSlashCommands = {
            slashCommands: d.slash_commands || [],
            skills: d.skills || [],
          };
          console.log(`Cached ${cachedSlashCommands.slashCommands.length} slash commands`);
        }
      } catch {}
      // Got what we need, kill the process
      proc.kill("SIGTERM");
    }
  });

  proc.on("error", (err) => {
    console.log(`Slash commands probe failed: ${err.message?.slice(0, 100)}`);
  });

  // Timeout safety
  setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
}

// Probe in background on startup
setTimeout(probeSlashCommands, 500);

// ─── MIME types ────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ─── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const readBody = () =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try { resolve(JSON.parse(body || "{}")); }
        catch { resolve({}); }
      });
    });

  // ── API ──

  if (pathname === "/api/sessions" && req.method === "GET") {
    const list = sessions.listAll().map((s) => {
      const runner = procs.get(s.id);
      return {
        ...s,
        processBusy: runner?.busy || false,
        queueLength: runner?.queue.length || 0,
      };
    });
    return json(list);
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    return readBody().then((body) => {
      const session = sessions.create({
        name: body.name,
        workingDir: body.working_dir || body.workingDir,
        permissionMode: body.permissionMode || body.permission_mode || "bypassPermissions",
      });
      json(session);
    });
  }

  if (pathname.startsWith("/api/sessions/") && pathname.endsWith("/rename") && req.method === "PUT") {
    const id = pathname.split("/")[3];
    return readBody().then((body) => {
      json(sessions.rename(id, body.name) ? { ok: true } : { error: "not found" });
    });
  }

  if (pathname.match(/^\/api\/sessions\/[^/]+\/messages$/) && req.method === "GET") {
    const id = pathname.split("/")[3];
    const session = sessions.get(id);
    if (!session) return json({ error: "not found" }, 404);
    return json(session.messages);
  }

  if (pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
    const id = pathname.split("/")[3];
    procs.remove(id);
    return json(sessions.delete(id) ? { ok: true } : { error: "not found" });
  }

  if (pathname === "/api/processes" && req.method === "GET") {
    return json(procs.status());
  }

  if (pathname === "/api/slash-commands" && req.method === "GET") {
    // Also update cache from any system_init if available
    return json(cachedSlashCommands || { slashCommands: [], skills: [] });
  }

  // ── Claude Code Native Sessions ──

  if (pathname === "/api/claude-sessions" && req.method === "GET") {
    return json(scanClaudeSessions());
  }

  if (pathname.match(/^\/api\/claude-sessions\/[^/]+\/messages$/) && req.method === "GET") {
    const id = pathname.split("/")[3];
    return json(readClaudeSessionMessages(id));
  }

  if (pathname.match(/^\/api\/claude-sessions\/[^/]+\/rename$/) && req.method === "PUT") {
    const id = pathname.split("/")[3];
    return readBody().then((body) => {
      json(renameClaudeSession(id, body.name));
    });
  }

  if (pathname.match(/^\/api\/claude-sessions\/[^/]+$/) && req.method === "DELETE") {
    const id = pathname.split("/")[3];
    return json(deleteClaudeSession(id));
  }

  if (pathname === "/api/claude-sessions/resume" && req.method === "POST") {
    return readBody().then((body) => {
      const claudeSessionId = body.sessionId;
      const name = body.name || "";
      const permissionMode = body.permissionMode || "bypassPermissions";
      // Find the native session to get its cwd
      const allSessions = scanClaudeSessions();
      const native = allSessions.find(s => s.sessionId === claudeSessionId);
      const workingDir = body.workingDir || (native ? native.cwd : process.env.HOME || "/home");

      // Create a web proxy session that reuses the native session ID
      const now = Date.now();
      const session = {
        id: claudeSessionId,
        name: name || (native ? native.title : `Resumed ${claudeSessionId.slice(0, 8)}`),
        createdAt: now,
        updatedAt: now,
        workingDir,
        permissionMode,
        messages: [],
        resumedFromNative: true, // Flag: always use --resume, never --session-id
      };
      // Save via session manager (use internal methods)
      sessions.sessions.set(session.id, session);
      sessions._save(session);
      json(session);
    });
  }

  if (pathname === "/api/memory" && req.method === "GET") {
    return json(getMemoryFiles());
  }

  if (pathname === "/api/memory/file" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return json({ error: "missing path" }, 400);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
      return json({ error: "forbidden" }, 403);
    }
    try {
      return json({ path: filePath, content: fs.readFileSync(filePath, "utf-8") });
    } catch {
      return json({ error: "not found" }, 404);
    }
  }

  if (pathname === "/api/memory/file" && req.method === "PUT") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return json({ error: "missing path" }, 400);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
      return json({ error: "forbidden" }, 403);
    }
    return readBody().then((body) => {
      if (typeof body.content !== "string") {
        return json({ error: "missing content" }, 400);
      }
      try {
        fs.writeFileSync(resolved, body.content, "utf-8");
        return json({ ok: true, path: filePath });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    });
  }

  if (pathname === "/api/memory/file" && req.method === "DELETE") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return json({ error: "missing path" }, 400);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
      return json({ error: "forbidden" }, 403);
    }
    try {
      fs.unlinkSync(resolved);
      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message }, 404);
    }
  }

  // ── Static files ──

  let filePath = pathname === "/"
    ? path.join(FRONTEND_DIR, "index.html")
    : path.join(FRONTEND_DIR, pathname);

  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  try {
    if (fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end("Not found");
    }
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

// ─── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sid = url.pathname.replace(/^\/ws\//, "");

  const session = sessions.get(sid);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", content: "Session not found" }));
    ws.close();
    return;
  }

  console.log(`[WS] Client connected for session ${sid.slice(0, 8)}`);

  const permMode = session.permissionMode || "bypassPermissions";
  const hasHistory = session.messages.length > 0 || session.resumedFromNative === true;
  const runner = procs.getOrCreate(sid, session.workingDir, permMode, hasHistory);
  const listeners = new Map();

  // Helper to wire event and track for cleanup
  function on(event, handler) {
    runner.on(event, handler);
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
  }

  function cleanup() {
    for (const [event, handlers] of listeners) {
      for (const h of handlers) runner.removeListener(event, h);
    }
    listeners.clear();
  }

  // Track current response for saving
  let responseParts = [];

  on("busy", (busy) => {
    wsSend(ws, { type: "status", busy });
  });

  on("delta", (text) => {
    responseParts.push(text);
    wsSend(ws, { type: "delta", content: text });
  });

  on("text", (text) => {
    responseParts.push(text);
    wsSend(ws, { type: "text", content: text });
  });

  on("result_text", (text) => {
    if (responseParts.length === 0) {
      responseParts.push(text);
    }
    wsSend(ws, { type: "result_text", content: text });
  });

  on("result_meta", (meta) => {
    wsSend(ws, { type: "meta", ...meta });
  });

  on("tool_use", (info) => {
    wsSend(ws, { type: "tool_use", name: info.name, id: info.id, input: info.input });
  });

  on("tool_use_start", (info) => {
    wsSend(ws, { type: "tool_use", name: info.name, id: info.id });
  });

  on("stderr", (text) => {
    wsSend(ws, { type: "stderr", content: text });
  });

  on("error", (text) => {
    wsSend(ws, { type: "error", content: text });
  });

  on("system_init", (event) => {
    // Update global cache
    if (event.slash_commands && event.slash_commands.length) {
      cachedSlashCommands = {
        slashCommands: event.slash_commands,
        skills: event.skills || [],
      };
    }
    wsSend(ws, {
      type: "system_init",
      model: event.model,
      tools: event.tools?.length || 0,
      slashCommands: event.slash_commands || [],
      skills: event.skills || [],
    });
  });

  on("system_event", (event) => {
    wsSend(ws, { type: "system", content: JSON.stringify(event) });
  });

  on("queued", (len) => {
    wsSend(ws, { type: "queued", queueLength: len });
  });

  on("done", () => {
    // Save accumulated assistant response
    const fullText = responseParts.join("");
    if (fullText) {
      sessions.addMessage(sid, "assistant", fullText);
    }
    responseParts = [];
    wsSend(ws, { type: "done" });
  });

  on("raw_event", (event) => {
    wsSend(ws, { type: "event", content: JSON.stringify(event) });
  });

  // Permission request from Claude → forward to web UI
  on("permission_request", (req) => {
    wsSend(ws, {
      type: "permission_request",
      id: req.id,
      toolName: req.toolName,
      input: req.input,
      riskLevel: req.riskLevel,
      description: req.description,
    });
  });

  // Handle messages from browser
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === "message") {
      const content = (data.content || "").trim();
      const images = data.images || []; // [{ media_type, data }]
      if (!content && !images.length) return;

      sessions.addMessage(sid, "user", content || "[image]");
      responseParts = [];
      runner.send(content, images);
    }

    if (data.type === "abort") {
      runner.abort();
      wsSend(ws, { type: "aborted" });
    }

    // Permission response from web UI → forward to Claude
    if (data.type === "permission_response") {
      runner.respondToPermission(data.id, data.allowed, data.reason);
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected for session ${sid.slice(0, 8)}`);
    cleanup();
  });
});

function wsSend(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Memory ────────────────────────────────────────────────────────────────────

function getMemoryFiles() {
  const results = [];
  const walk = (dir, base) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "statsig"].includes(entry.name)) continue;
          walk(full, base);
        } else if (entry.isFile()) {
          if ([".md", ".json", ".txt", ".yaml", ".yml"].includes(path.extname(entry.name))) {
            try {
              const stat = fs.statSync(full);
              results.push({
                path: path.relative(base, full),
                fullPath: full,
                size: stat.size,
                mtime: stat.mtimeMs,
                content: fs.readFileSync(full, "utf-8").slice(0, 10000),
              });
            } catch {}
          }
        }
      }
    } catch {}
  };
  if (fs.existsSync(MEMORY_DIR)) walk(MEMORY_DIR, MEMORY_DIR);
  return results;
}

// ─── Claude Native Sessions ─────────────────────────────────────────────────────

function scanClaudeSessions() {
  const results = [];
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return results;

  try {
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(CLAUDE_PROJECTS_DIR, proj.name);
      // Keep raw dir name, actual cwd will come from session data
      const projectPath = proj.name;

      try {
        const files = fs.readdirSync(projDir).filter(f => f.endsWith(".jsonl") && !f.includes("subagent"));
        for (const file of files) {
          const sessionId = file.replace(".jsonl", "");
          const filePath = path.join(projDir, file);
          try {
            const info = parseClaudeSession(filePath, sessionId, projectPath);
            if (info) results.push(info);
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // Sort by most recent first
  results.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  return results;
}

function parseClaudeSession(filePath, sessionId, projectPath) {
  const fd = fs.openSync(filePath, "r");
  try {
    // Read first 32KB to get metadata + first prompt, and last 16KB for recent timestamp
    const headBuf = Buffer.alloc(32768);
    const headBytes = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const headText = headBuf.toString("utf-8", 0, headBytes);
    const headLines = headText.split("\n").filter(l => l.trim());

    let customTitle = "";
    let cwd = "";
    let firstPrompt = "";
    let firstTimestamp = "";
    let lastTimestamp = "";
    let messageCount = 0;
    let gitBranch = "";

    for (const line of headLines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "custom-title" && !customTitle) {
          customTitle = obj.customTitle || "";
        }
        if (obj.type === "user" && !obj.isMeta && obj.message?.content) {
          messageCount++;
          if (!firstPrompt) {
            const content = obj.message.content;
            // Skip command messages
            if (!content.startsWith("<command-name>") && !content.startsWith("[{")) {
              firstPrompt = content.slice(0, 120);
            }
          }
          if (!cwd && obj.cwd) cwd = obj.cwd;
          if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
          if (!firstTimestamp && obj.timestamp) firstTimestamp = obj.timestamp;
          if (obj.timestamp) lastTimestamp = obj.timestamp;
        }
        if (obj.type === "assistant") {
          messageCount++;
          if (obj.timestamp) lastTimestamp = obj.timestamp;
        }
      } catch {}
    }

    // Try to read last chunk for most recent timestamp
    const stat = fs.fstatSync(fd);
    if (stat.size > 32768) {
      const tailBuf = Buffer.alloc(16384);
      const tailOffset = Math.max(0, stat.size - 16384);
      const tailBytes = fs.readSync(fd, tailBuf, 0, tailBuf.length, tailOffset);
      const tailText = tailBuf.toString("utf-8", 0, tailBytes);
      const tailLines = tailText.split("\n").filter(l => l.trim());
      for (let i = tailLines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(tailLines[i]);
          if (obj.timestamp) {
            lastTimestamp = obj.timestamp;
            break;
          }
        } catch {}
      }
    }

    // Generate a display title
    const title = customTitle || firstPrompt || sessionId.slice(0, 8);

    return {
      sessionId,
      title,
      customTitle,
      firstPrompt: firstPrompt || "",
      cwd: cwd || projectPath,
      projectPath,
      gitBranch,
      messageCount,
      firstTimestamp: firstTimestamp ? new Date(firstTimestamp).getTime() : 0,
      lastTimestamp: lastTimestamp ? new Date(lastTimestamp).getTime() : 0,
      filePath,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readClaudeSessionMessages(sessionId) {
  // Find the session file
  const allSessions = scanClaudeSessions();
  const session = allSessions.find(s => s.sessionId === sessionId);
  if (!session) return { error: "not found" };

  const messages = [];
  try {
    const content = fs.readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && !obj.isMeta && obj.message?.content) {
          const content = obj.message.content;
          if (!content.startsWith("<command-name>") && !content.startsWith("[{")) {
            messages.push({
              role: "user",
              content,
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : 0,
            });
          }
        } else if (obj.type === "assistant" && obj.message?.content) {
          // Extract text from content blocks
          const textParts = [];
          for (const block of obj.message.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "tool_use") {
              textParts.push(`[Tool: ${block.name}]`);
            }
          }
          if (textParts.length > 0) {
            messages.push({
              role: "assistant",
              content: textParts.join("\n"),
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : 0,
            });
          }
        }
      } catch {}
    }
  } catch {}

  return messages;
}

function renameClaudeSession(sessionId, newName) {
  const allSessions = scanClaudeSessions();
  const session = allSessions.find(s => s.sessionId === sessionId);
  if (!session) return { error: "not found" };
  if (!newName || !newName.trim()) return { error: "name required" };

  try {
    const content = fs.readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n");

    // Remove ALL existing custom-title lines
    const filtered = lines.filter(line => {
      if (!line.trim()) return true;
      try {
        const obj = JSON.parse(line);
        return obj.type !== "custom-title";
      } catch { return true; }
    });

    // Insert new custom-title as first line
    const titleLine = JSON.stringify({
      type: "custom-title",
      customTitle: newName.trim(),
      sessionId,
    });
    filtered.unshift(titleLine);

    fs.writeFileSync(session.filePath, filtered.join("\n"));
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

function deleteClaudeSession(sessionId) {
  const allSessions = scanClaudeSessions();
  const session = allSessions.find(s => s.sessionId === sessionId);
  if (!session) return { error: "not found" };

  try {
    // Delete the main session jsonl
    fs.unlinkSync(session.filePath);

    // Delete subagents directory if it exists
    const subagentsDir = path.join(path.dirname(session.filePath), sessionId, "subagents");
    if (fs.existsSync(subagentsDir)) {
      fs.rmSync(path.join(path.dirname(session.filePath), sessionId), { recursive: true, force: true });
    }

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────────

process.on("SIGINT", () => { procs.killAll(); process.exit(0); });
process.on("SIGTERM", () => { procs.killAll(); process.exit(0); });

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       claude-code-web-proxy");
  console.log(`║       http://${HOST}:${PORT}`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
});
