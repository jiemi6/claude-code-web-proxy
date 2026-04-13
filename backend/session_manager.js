/**
 * Session Manager - manages Claude Code sessions with persistence.
 * Each session has a UUID that maps to a Claude Code --session-id.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data", "sessions");

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._loadAll();
  }

  _loadAll() {
    try {
      const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(DATA_DIR, file), "utf-8")
          );
          this.sessions.set(data.id, data);
        } catch {}
      }
    } catch {}
  }

  _save(session) {
    const filePath = path.join(DATA_DIR, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  }

  create({ name = "", workingDir = "", permissionMode = "bypassPermissions" } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session = {
      id,
      name: name || `Session ${this.sessions.size + 1}`,
      createdAt: now,
      updatedAt: now,
      workingDir: workingDir || process.env.HOME || "/home",
      permissionMode,
      messages: [],
    };
    this.sessions.set(id, session);
    this._save(session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  listAll() {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        workingDir: s.workingDir,
        permissionMode: s.permissionMode || "bypassPermissions",
        messageCount: s.messages.length,
      }));
  }

  delete(id) {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    try {
      fs.unlinkSync(path.join(DATA_DIR, `${id}.json`));
    } catch {}
    return true;
  }

  rename(id, name) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.name = name;
    session.updatedAt = Date.now();
    this._save(session);
    return true;
  }

  addMessage(id, role, content) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.messages.push({ role, content, timestamp: Date.now() });
    session.updatedAt = Date.now();
    this._save(session);
  }
}

module.exports = SessionManager;
