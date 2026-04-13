# claude-code-web-proxy

> 📖 **Languages:** [中文](./README.md) | [English](./docs/README.en.md)

<p align="center">
  <img src="./docs/logo.svg" alt="claude-code-web-proxy logo" width="120">
</p>
<p align="center">
  <img src="./docs/screenshot.png" alt="screenshot" width="100%">
</p>

一个基于 Web 的 Claude Code CLI 代理，提供浏览器界面来管理和使用多个 Claude Code 会话。

## ✨ 核心亮点

- 🚀 **零侵入，直接驱动 Claude Code CLI** — 本项目只是 `claude` 命令的一层 Web 外壳，**不代理、不改写任何对话内容**，不碰 Anthropic API。Claude CLI 怎么跑，这里就怎么跑，升级 CLI 无需同步升级本项目
- 📂 **Session + Memory 双管理** — 会话侧边栏支持创建、切换、重命名、删除、断线续连；Memory 面板按项目分组，支持浏览 / 编辑 / 删除 `~/.claude/` 下的记忆文件，折叠状态跨刷新保留
- ⚡ **多 Session 并行，效率倍增** — 每个会话一个独立子进程，真正的并行而非轮询；在浏览器里同时推进多个任务（重构 A、调试 B、跑测试 C），互不阻塞
- 🌐 **环境友好，网络/代码隔离** — 把 Claude CLI 和本项目一起放进隔离环境（虚拟机 / 远程机器），让 CLI 所需的全局代理和国内开发环境彻底解耦，本机网络和工作流完全不受影响

## 🎯 推荐玩法

1. **本地虚拟机方案** — 在本地虚拟机里部署 `claude` CLI 和 `claude-code-web-proxy`，虚拟机内开启全局代理；宿主机网络保持原样，通过虚拟机 IP 打开 Web UI 即可。代码直接用虚拟机软件自带的**共享目录**（VirtualBox Shared Folders / VMware Shared Folders / Parallels 等）挂载宿主机项目路径就行，无需走网络协议
2. **远程部署方案** — 把 CLI 和本项目部署到海外 VPS 或公司远程开发机上，浏览器直接访问。代码同步两种思路：**网络挂载**（sshfs / SMB / NFS，把远程目录挂到本地当本地盘用，编辑器体验几乎无感），或者用 git / rsync / mutagen 做双向同步。网络挂载方案同样适用于虚拟机场景

> 两种方式均已长期实测，**Claude 账号未出现封禁**。核心是让 CLI 跑在一个"干净"的网络环境里，而不是在宿主机上东拼西凑代理规则。

## 其他功能

- **实时流式输出** — 通过 WebSocket 实时推送 Claude 的回复内容、工具调用过程和状态变化
- **会话持久化** — 消息历史自动保存到磁盘，服务重启后不丢失
- **权限交互** — 支持多种权限模式，包括通过 Web 弹窗进行交互式授权（基于 MCP）
- **深色主题** — Tokyonight 风格的暗色 UI

## 系统要求

- **Node.js** 14+
- **Claude Code CLI** 已安装并可在 PATH 中访问（通常位于 `~/.local/bin/claude`）

## 快速开始

### 安装

```bash
git clone https://github.com/jiemi6/claude-code-web-proxy.git
cd claude-code-web-proxy
npm install
```

项目只有一个运行时依赖（`ws` WebSocket 库），安装非常快。

### 启动服务

```bash
# 推荐方式（自动配置 PATH 并安装依赖）
./start.sh

# 或者直接启动
npm start

# 开发模式（文件修改后自动重载）
npm run dev
```

### 访问

打开浏览器访问 `http://localhost:8199`。

### 后台部署

使用内置的管理脚本 `deploy.sh` 将服务作为后台进程运行：

```bash
./deploy.sh start     # 启动服务（后台运行，输出写入 app.log）
./deploy.sh status    # 查看运行状态
./deploy.sh log       # 实时查看日志
./deploy.sh restart   # 重启服务
./deploy.sh stop      # 停止服务
```

如需开机自启，可参考下方的 systemd 示例：

```ini
# /etc/systemd/system/claude-code-web-proxy.service
[Unit]
Description=claude-code-web-proxy
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-code-web-proxy
ExecStart=/usr/bin/node backend/server.js
Environment=HOST=192.168.1.100  # 替换为本机局域网 IP，或不设置由程序自动检测
Environment=PORT=8199
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-code-web-proxy
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | 自动检测局域网 IPv4 | 服务监听地址（默认仅局域网可访问，不绑定到 `0.0.0.0`） |
| `PORT` | `8199` | 服务监听端口 |
| `CLAUDE_BIN` | 自动检测 | Claude CLI 可执行文件路径 |

示例：

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

## 使用说明

### 创建会话

1. 点击侧边栏的 **"New"** 按钮
2. 填写会话名称（可选，默认自动生成）
3. 设置工作目录（Claude 将在此目录下执行操作）
4. 选择权限模式
5. 点击确认创建

### 权限模式

| 模式 | 说明 |
|------|------|
| `bypassPermissions` | 跳过所有权限检查，最快速但不安全 |
| `acceptEdits` | 自动批准文件编辑操作 |
| `auto` | 智能风险分类，自动判断是否需要授权 |
| `default` | 标准严格模式，所有敏感操作需确认 |
| `mcp` | 通过 Web 弹窗交互式审批，推荐用于需要精细控制的场景 |

### 发送消息

- 在底部输入框输入提示词
- 按 **Enter** 发送，**Shift+Enter** 换行
- 发送后可实时看到 Claude 的流式回复和工具调用过程

### 中断操作

在 Claude 处理中时，可以点击发送按钮（此时显示为中断按钮）来终止当前操作。

### 浏览与管理 Memory 文件

切换侧边栏到 **"Memory"** 标签页，可查看 `~/.claude/` 下的 `.md`、`.json`、`.txt`、`.yaml` 等文件。

- **按项目分组**：文件按 `projects/<slug>` 自动分组，每组可折叠，折叠状态保存在 `localStorage`。顶层文件（如 `~/.claude/CLAUDE.md`）归入 **Global** 组
- **按修改时间排序**：组内最近修改的排在最前，条目显示子路径、大小和相对时间
- **点击条目**：展开查看完整内容
- **✎ 编辑**：内联打开文本编辑器，修改后点击 Save 保存（直接写回文件）
- **× 删除**：删除文件（会弹出确认框，操作不可逆）

所有写操作都限制在 `~/.claude/` 目录内，路径越界会被拒绝（403）。

## 架构概览

```
claude-code-web-proxy/
├── backend/
│   ├── server.js              # HTTP/WebSocket 服务器
│   ├── process_manager.js     # Claude 子进程管理
│   ├── session_manager.js     # 会话持久化存储
│   ├── permission_mcp.js      # MCP 权限交互服务
│   └── data/sessions/         # 会话数据文件
├── frontend/
│   ├── index.html             # 单页应用
│   └── static/style.css       # 样式
├── start.sh                   # 启动脚本
└── docs/                      # 文档（API.md、README.en.md 等）
```

### 核心模块

**Server** — 提供 REST API 和 WebSocket 服务，负责路由请求、静态文件服务和 Memory 文件扫描。

**Process Manager** — 为每个会话维护一个 `claude` 子进程（`SessionRunner`）。内置消息队列，确保同一会话中命令按顺序执行。解析 Claude 的 `stream-json` 输出，将其转换为结构化事件推送到前端。

**Session Manager** — 将会话元数据和消息历史以 JSON 文件形式保存在 `backend/data/sessions/` 目录下，实现跨重启持久化。

**Permission MCP Server** — 基于 Unix Socket 的 MCP 服务器，在 `mcp` 权限模式下接收 Claude 的权限请求，转发到 Web 前端弹窗，等待用户审批后将结果返回给 Claude。超时时间为 5 分钟。

### 数据流

```
用户输入 → WebSocket → Server → ProcessManager → claude CLI 子进程
                                                        ↓
用户界面 ← WebSocket ← Server ← 事件解析 ← stream-json 输出
```

## API

完整的 API 文档见 [docs/API.md](./docs/API.md)，以下为常用接口：

### REST API

```
GET    /api/sessions              # 获取所有会话列表
POST   /api/sessions              # 创建新会话
GET    /api/sessions/:id/messages # 获取会话消息历史
PUT    /api/sessions/:id/rename   # 重命名会话
DELETE /api/sessions/:id          # 删除会话并终止进程
GET    /api/processes             # 查看所有运行中的进程状态
GET    /api/memory                # 扫描 Memory 文件列表
GET    /api/memory/file?path=...  # 读取指定 Memory 文件内容
PUT    /api/memory/file?path=...  # 保存（覆盖写入）Memory 文件
DELETE /api/memory/file?path=...  # 删除指定 Memory 文件
```

### WebSocket

连接地址：`ws://<host>:<port>/ws/:sessionId`

**客户端 → 服务端：**

```json
{ "type": "message", "content": "你的提示词" }
{ "type": "abort" }
{ "type": "permission_response", "id": "请求ID", "allowed": true }
```

**服务端 → 客户端：**

```json
{ "type": "status", "busy": true }
{ "type": "system_init", "model": "claude-sonnet-4-6", "tools": 12 }
{ "type": "delta", "content": "流式文本片段..." }
{ "type": "tool_use", "name": "Bash", "input": { "command": "ls" } }
{ "type": "result_text", "content": "最终回复内容" }
{ "type": "meta", "total_cost_usd": 0.05, "duration_ms": 3200, "num_turns": 2 }
{ "type": "done" }
```

## 会话数据格式

每个会话保存为 `backend/data/sessions/{uuid}.json`：

```json
{
  "id": "e6cf52ba-5b16-4c18-ad9d-d7ad61148714",
  "name": "我的项目",
  "createdAt": 1773115029038,
  "updatedAt": 1773121943159,
  "workingDir": "/home/user/project",
  "permissionMode": "bypassPermissions",
  "messages": [
    { "role": "user", "content": "列出文件", "timestamp": 1773115033448 },
    { "role": "assistant", "content": "这是文件列表...", "timestamp": 1773115053912 }
  ]
}
```

## 常见问题

**Q: 找不到 claude 命令？**

确保 Claude Code CLI 已安装。可以通过设置 `CLAUDE_BIN` 环境变量指定完整路径：

```bash
CLAUDE_BIN=/path/to/claude npm start
```

**Q: 如何修改监听端口？**

```bash
PORT=3000 npm start
```

**Q: 会话数据存储在哪里？**

所有会话数据保存在 `backend/data/sessions/` 目录下，每个会话一个 JSON 文件。删除文件即可清除对应会话。

**Q: 支持多用户同时使用吗？**

当前设计为单用户使用。多个浏览器标签页可以连接到同一个会话，但会共享同一个 Claude 进程。

## License

MIT
