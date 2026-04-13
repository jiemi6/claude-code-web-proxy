# claude-code-web-proxy - API Documentation

Base URL: `http://<host>:<port>` (default: auto-detected LAN IPv4 on port `8199`)

---

## REST API

### 1. List Sessions

```
GET /api/sessions
```

Returns all sessions sorted by last update time (newest first).

**Response:**

```json
[
  {
    "id": "uuid",
    "name": "My Project",
    "createdAt": 1773112385222,
    "updatedAt": 1773112411215,
    "workingDir": "/home/user/project",
    "permissionMode": "bypassPermissions",
    "messageCount": 5,
    "processBusy": false,
    "queueLength": 0
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| id | string | Session UUID, also used as Claude Code's `--session-id` |
| name | string | Display name |
| createdAt | number | Unix timestamp (ms) |
| updatedAt | number | Unix timestamp (ms), updated on each message |
| workingDir | string | Claude Code working directory for this session |
| permissionMode | string | Permission mode (see below) |
| messageCount | number | Total messages in this session |
| processBusy | boolean | Whether Claude is currently processing a message |
| queueLength | number | Number of queued messages waiting to be processed |

---

### 2. Create Session

```
POST /api/sessions
Content-Type: application/json
```

**Request Body:**

```json
{
  "name": "My Project",
  "working_dir": "/home/user/project",
  "permissionMode": "bypassPermissions"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | No | `"Session N"` | Display name |
| working_dir | string | No | `$HOME` | Claude Code working directory |
| permissionMode | string | No | `"bypassPermissions"` | Permission mode |

**Permission Modes:**

| Value | Description |
|-------|-------------|
| `bypassPermissions` | Skip all permission checks, Claude operates freely |
| `acceptEdits` | Auto-accept file edits, other operations follow default rules |
| `auto` | Smart classifier auto-approves safe operations |
| `default` | Strict mode, permission-required operations will fail in `-p` mode |

**Response:** The created session object.

```json
{
  "id": "e6cf52ba-5b16-4c18-ad9d-d7ad61148714",
  "name": "My Project",
  "createdAt": 1773112385222,
  "updatedAt": 1773112385222,
  "workingDir": "/home/user/project",
  "permissionMode": "bypassPermissions",
  "messages": []
}
```

---

### 3. Delete Session

```
DELETE /api/sessions/:id
```

Deletes the session and kills any associated Claude process.

**Response:**

```json
{ "ok": true }
```

Error (404):

```json
{ "error": "not found" }
```

---

### 4. Rename Session

```
PUT /api/sessions/:id/rename
Content-Type: application/json
```

**Request Body:**

```json
{ "name": "New Name" }
```

**Response:**

```json
{ "ok": true }
```

---

### 5. Get Session Messages

```
GET /api/sessions/:id/messages
```

Returns the full message history for a session.

**Response:**

```json
[
  {
    "role": "user",
    "content": "list files in /tmp",
    "timestamp": 1773112400000
  },
  {
    "role": "assistant",
    "content": "Here are the files in /tmp:\n...",
    "timestamp": 1773112405000
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| role | string | `"user"` or `"assistant"` |
| content | string | Message text |
| timestamp | number | Unix timestamp (ms) |

---

### 6. List Process Status

```
GET /api/processes
```

Returns the runtime status of all active session runners.

**Response:**

```json
[
  {
    "sessionId": "uuid",
    "busy": false,
    "queueLength": 0,
    "permissionMode": "bypassPermissions"
  }
]
```

---

### 7. List Memory Files

```
GET /api/memory
```

Scans `~/.claude/` for memory files (`.md`, `.json`, `.txt`, `.yaml`, `.yml`) and returns their content.

**Response:**

```json
[
  {
    "path": "projects/myproject/MEMORY.md",
    "fullPath": "/home/user/.claude/projects/myproject/MEMORY.md",
    "size": 2048,
    "mtime": 1744552800000,
    "content": "# Project Notes\n..."
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| path | string | Relative path from `~/.claude/` |
| fullPath | string | Absolute path |
| size | number | File size in bytes |
| mtime | number | Last-modified time (ms since epoch) |
| content | string | File content (truncated to 10000 chars) |

---

### 8. Read Memory File

```
GET /api/memory/file?path=/home/user/.claude/some/file.md
```

Read a specific file under `~/.claude/`. Paths outside `~/.claude/` are rejected (403).

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| path | Yes | Absolute file path |

**Response:**

```json
{
  "path": "/home/user/.claude/some/file.md",
  "content": "file content..."
}
```

**Errors:**

| Status | Body |
|--------|------|
| 400 | `{ "error": "missing path" }` |
| 403 | `{ "error": "forbidden" }` |
| 404 | `{ "error": "not found" }` |

---

### 9. Update Memory File

```
PUT /api/memory/file?path=/home/user/.claude/some/file.md
```

Overwrite an existing memory file. Paths outside `~/.claude/` are rejected (403).

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| path | Yes | Absolute file path |

**Request Body:**

```json
{ "content": "new file content..." }
```

**Response:**

```json
{ "ok": true, "path": "/home/user/.claude/some/file.md" }
```

**Errors:**

| Status | Body |
|--------|------|
| 400 | `{ "error": "missing path" }` or `{ "error": "missing content" }` |
| 403 | `{ "error": "forbidden" }` |
| 500 | `{ "error": "<write error>" }` |

---

### 10. Delete Memory File

```
DELETE /api/memory/file?path=/home/user/.claude/some/file.md
```

Delete a memory file under `~/.claude/`. Paths outside `~/.claude/` are rejected (403).

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| path | Yes | Absolute file path |

**Response:**

```json
{ "ok": true }
```

**Errors:**

| Status | Body |
|--------|------|
| 400 | `{ "error": "missing path" }` |
| 403 | `{ "error": "forbidden" }` |
| 404 | `{ "error": "<unlink error>" }` |

---

## WebSocket API

### Connection

```
ws://<host>:<port>/ws/:sessionId
```

Connect to a session's real-time event stream. Connecting also initializes the session's Claude Code runner (if not already running).

If the session ID is invalid, the server sends an `error` event and closes the connection.

---

### Client → Server Messages

All messages are JSON with a `type` field.

#### Send Chat Message

```json
{
  "type": "message",
  "content": "your prompt text"
}
```

Sends a prompt to Claude Code. If Claude is already processing a previous message, this one is queued.

#### Abort

```json
{
  "type": "abort"
}
```

Kills the currently running Claude process and clears the message queue.

#### Permission Response

```json
{
  "type": "permission_response",
  "id": "request-uuid",
  "allowed": true,
  "reason": "Approved via web UI"
}
```

Responds to a permission request from Claude (only applicable when `permissionMode` is `"mcp"`).

| Field | Type | Description |
|-------|------|-------------|
| id | string | The `id` from the `permission_request` event |
| allowed | boolean | `true` to allow, `false` to deny |
| reason | string | Optional reason text |

---

### Server → Client Events

All events are JSON with a `type` field.

#### `status`

```json
{ "type": "status", "busy": true }
```

Indicates Claude has started (`busy: true`) or finished (`busy: false`) processing.

#### `system_init`

```json
{ "type": "system_init", "model": "claude-opus-4-6", "tools": 23 }
```

Emitted when Claude process initializes. Contains the model name and number of available tools.

#### `delta`

```json
{ "type": "delta", "content": "partial text..." }
```

Streaming text chunk from Claude's response. Concatenate all deltas for the full intermediate text.

#### `text`

```json
{ "type": "text", "content": "text line" }
```

Non-JSON text output from Claude (fallback for non-standard output).

#### `result_text`

```json
{ "type": "result_text", "content": "Final complete answer from Claude..." }
```

The **definitive final answer** for this turn. Always appears at the end of a turn. This is the authoritative response text — display it as the final message.

#### `tool_use`

```json
{
  "type": "tool_use",
  "name": "Bash",
  "id": "tool-call-id",
  "input": { "command": "ls /tmp" }
}
```

Claude is invoking a tool. Common tool names: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebSearch`.

#### `meta`

```json
{
  "type": "meta",
  "total_cost_usd": 0.0312,
  "duration_ms": 9610,
  "num_turns": 3,
  "session_id": "uuid",
  "is_error": false,
  "stop_reason": "end_turn"
}
```

Turn metadata. Sent after `result_text`, before `done`.

| Field | Type | Description |
|-------|------|-------------|
| total_cost_usd | number | Total API cost for this turn |
| duration_ms | number | Total wall-clock time |
| duration_api_ms | number | Time spent in API calls |
| num_turns | number | Number of agentic turns (tool use cycles) |
| session_id | string | Claude Code session ID |
| is_error | boolean | Whether the result was an error |
| stop_reason | string | Why Claude stopped (`"end_turn"`, etc.) |

#### `done`

```json
{ "type": "done" }
```

**Turn complete signal.** The response is fully generated, message has been saved. The client should:
- Finalize the assistant message display
- Re-enable the input field for the next message
- Reset busy/loading UI state

#### `queued`

```json
{ "type": "queued", "queueLength": 2 }
```

A message was queued because Claude is busy with a previous message.

#### `error`

```json
{ "type": "error", "content": "error description" }
```

An error occurred (process spawn failure, Claude exit with non-zero code, etc.).

#### `stderr`

```json
{ "type": "stderr", "content": "stderr output from claude" }
```

Standard error output from the Claude process. May contain warnings or debug info.

#### `aborted`

```json
{ "type": "aborted" }
```

Confirms the current process was killed in response to an `abort` request.

#### `permission_request`

```json
{
  "type": "permission_request",
  "id": "request-uuid",
  "toolName": "Edit",
  "description": "Write to /home/user/file.js",
  "input": { "file_path": "/home/user/file.js" },
  "riskLevel": "medium"
}
```

Claude is requesting permission to perform an operation (only when `permissionMode` is `"mcp"`). The client should display a prompt and respond with a `permission_response` message.

#### `system`

```json
{ "type": "system", "content": "{\"type\":\"system\",\"subtype\":\"...\"}" }
```

Other system events from Claude (JSON-encoded).

#### `event`

```json
{ "type": "event", "content": "{...}" }
```

Unknown/unhandled events from Claude's stream-json output (JSON-encoded, for debugging).

---

## Event Flow

### Typical single-turn (no tools):

```
Client                          Server
  |-- message ------------------>|
  |<-- status { busy: true } ----|
  |<-- system_init --------------|
  |<-- delta (streaming) --------|  (0..N chunks)
  |<-- result_text --------------|  (final answer)
  |<-- meta ---------------------|
  |<-- status { busy: false } ---|
  |<-- done ---------------------|  (turn complete, UI reset)
```

### Multi-turn with tool use:

```
Client                          Server
  |-- message ------------------>|
  |<-- status { busy: true } ----|
  |<-- system_init --------------|
  |<-- delta (thinking text) ----|
  |<-- tool_use { Bash } --------|
  |<-- delta (tool result text) -|
  |<-- tool_use { Edit } --------|
  |<-- delta (more text) --------|
  |<-- result_text --------------|  (final answer at bottom)
  |<-- meta ---------------------|
  |<-- status { busy: false } ---|
  |<-- done ---------------------|
```

### Permission request flow (permissionMode: "mcp"):

```
Client                              Server
  |-- message ---------------------->|
  |<-- status { busy: true } --------|
  |<-- permission_request ------------|
  |-- permission_response { allow } ->|
  |<-- delta / result_text -----------|
  |<-- done --------------------------|
```
