/**
 * Permission MCP Server
 *
 * A minimal MCP (Model Context Protocol) server that handles permission prompts
 * from Claude Code's --permission-prompt-tool flag.
 *
 * When Claude needs a permission (file write, bash command, etc.),
 * it calls this MCP tool. We forward the request to the web UI via callback,
 * wait for user response, and return allow/deny to Claude.
 *
 * Protocol: JSON-RPC over stdio (MCP standard)
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SOCKET_DIR = path.join(__dirname, "data", "sockets");
fs.mkdirSync(SOCKET_DIR, { recursive: true });

/**
 * Creates a per-session MCP permission server on a Unix socket.
 * Returns the socket path and control methods.
 */
function createPermissionServer(sessionId, onPermissionRequest) {
  const socketPath = path.join(SOCKET_DIR, `perm-${sessionId.slice(0, 8)}.sock`);

  // Clean up stale socket
  try { fs.unlinkSync(socketPath); } catch {}

  const pendingRequests = new Map();
  let clientConn = null;

  const server = net.createServer((conn) => {
    clientConn = conn;
    let buffer = "";

    conn.on("data", (chunk) => {
      buffer += chunk.toString();

      // MCP uses Content-Length headers (LSP style)
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) break;

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);

        try {
          const msg = JSON.parse(body);
          handleMessage(conn, msg);
        } catch (err) {
          console.error(`[MCP:${sessionId.slice(0, 8)}] Parse error:`, err.message);
        }
      }
    });

    conn.on("close", () => {
      clientConn = null;
    });

    conn.on("error", () => {
      clientConn = null;
    });
  });

  function sendMessage(conn, msg) {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    conn.write(header + body);
  }

  function handleMessage(conn, msg) {
    // JSON-RPC message handling
    if (msg.method === "initialize") {
      // MCP initialization handshake
      sendMessage(conn, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "claude-code-web-proxy-permissions",
            version: "1.0.0",
          },
        },
      });
    } else if (msg.method === "notifications/initialized") {
      // Client acknowledged initialization - no response needed
    } else if (msg.method === "tools/list") {
      sendMessage(conn, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "web_proxy_permission",
              description: "Handle permission prompts via web UI",
              inputSchema: {
                type: "object",
                properties: {
                  tool_name: { type: "string", description: "Tool requesting permission" },
                  input: { type: "object", description: "Tool input/arguments" },
                  risk_level: { type: "string", description: "Risk level" },
                  description: { type: "string", description: "Description of what the tool wants to do" },
                },
                required: ["tool_name"],
              },
            },
          ],
        },
      });
    } else if (msg.method === "tools/call") {
      // This is the actual permission request from Claude!
      const args = msg.params?.arguments || {};
      const requestId = crypto.randomUUID();

      console.log(`[MCP:${sessionId.slice(0, 8)}] Permission request: ${args.tool_name} - ${args.description || ""}`);

      // Forward to web UI and wait for response
      const promise = new Promise((resolve) => {
        pendingRequests.set(requestId, resolve);

        // Auto-timeout after 5 minutes
        setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            resolve({ allowed: false, reason: "Timeout - no response from web UI" });
          }
        }, 300000);
      });

      onPermissionRequest({
        id: requestId,
        toolName: args.tool_name,
        input: args.input,
        riskLevel: args.risk_level,
        description: args.description,
      });

      promise.then((response) => {
        sendMessage(conn, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  allowed: response.allowed,
                  reason: response.reason || (response.allowed ? "Approved via web UI" : "Denied via web UI"),
                }),
              },
            ],
          },
        });
      });
    } else if (msg.id !== undefined) {
      // Unknown request - respond with empty result
      sendMessage(conn, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {},
      });
    }
  }

  server.listen(socketPath, () => {
    console.log(`[MCP:${sessionId.slice(0, 8)}] Permission server listening on ${socketPath}`);
  });

  return {
    socketPath,

    /**
     * Resolve a pending permission request from the web UI.
     */
    respondToPermission(requestId, allowed, reason) {
      const resolve = pendingRequests.get(requestId);
      if (resolve) {
        pendingRequests.delete(requestId);
        resolve({ allowed, reason });
        return true;
      }
      return false;
    },

    /**
     * Close the MCP server.
     */
    close() {
      server.close();
      try { fs.unlinkSync(socketPath); } catch {}
      // Reject all pending requests
      for (const [id, resolve] of pendingRequests) {
        resolve({ allowed: false, reason: "Server shutting down" });
      }
      pendingRequests.clear();
    },

    get hasPending() {
      return pendingRequests.size > 0;
    },
  };
}

module.exports = { createPermissionServer };
