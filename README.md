# Gemini Web API Bridge

通过浏览器扩展同步已登录的 Gemini 会话 Cookie，并由 Rust 服务端直接调用 Gemini Web API，让本地程序可以在不使用 Google AI Studio API Key 的情况下与 Gemini 进行交互。

> 当前版本已经从 Node.js 后端迁移到 Rust，Rust 服务端可以正常完成 Cookie 同步、Gemini 会话参数提取、单轮请求以及带 `conversationId` 的多轮对话。

[English version](#gemini-web-api-bridge-1)

## ✨ 功能特性

- **无需 API Key**：使用已登录的 `gemini.google.com` 浏览器会话。
- **Rust 后端**：使用 Axum、Tokio 和 Reqwest 实现 HTTP 服务及 Gemini API 请求。
- **直接调用 Gemini Web API**：不再依赖 DOM 抓取、页面注入或长轮询。
- **自动同步 Cookie**：Chrome 扩展定期读取 Gemini/Google Cookie，并同步到本地 Rust 服务端。
- **会话参数自动刷新**：服务端从 Gemini 页面提取 `SNlM0e`、`bl`、`f.sid` 等参数，并按 TTL 刷新。
- **多轮对话**：客户端可以传入同一个 `conversationId`，服务端会保存对应的 Gemini 对话上下文。
- **兼容多种请求格式**：完成接口支持直接传入 `prompt`，也支持传入 `messages` 数组并使用最后一条消息。
- **代理支持**：支持通过 `https_proxy`、`HTTPS_PROXY`、`http_proxy` 或 `HTTP_PROXY` 配置网络代理。
- **扩展状态检查**：Popup 页面可以查看 Cookie、Session Token 和服务端连接状态。

## 🏗️ 系统架构

项目由两个部分组成：

```text
┌──────────────────────┐       Cookie Sync        ┌──────────────────────────┐
│ Chrome Extension     │ ───────────────────────▶ │ Rust Bridge Server       │
│ WXT + TypeScript     │                         │ Axum + Tokio + Reqwest   │
└──────────────────────┘                         └────────────┬─────────────┘
          │                                                   │
          │ 已登录 Gemini 会话                                │ Gemini Web API
          ▼                                                   ▼
┌──────────────────────┐                         ┌──────────────────────────┐
│ gemini.google.com    │ ◀────────────────────── │ Gemini StreamGenerate    │
└──────────────────────┘                         └──────────────────────────┘

本地客户端 / Pi Agent ── POST /api/bridge/completions ──▶ Rust Bridge Server
```

### Chrome Extension

- 使用 WXT 构建，运行在 Chrome/Chromium 浏览器中。
- 通过 `cookies` 权限读取 `gemini.google.com` 及必要的 Google Cookie。
- 默认每 30 秒同步一次 Cookie，也可以在 Popup 中手动同步。
- 扩展只负责获取和同步浏览器会话，不负责抓取 Gemini 页面 DOM。

### Rust Bridge Server

代码位于 `GeminiWebAPIBridgeRust/`，主要职责包括：

1. 接收扩展同步的 Cookie。
2. 访问 Gemini `/app` 页面并提取当前会话参数。
3. 构造 `f.req` 请求并调用 Gemini `StreamGenerate` 接口。
4. 解析 Gemini 返回的流式响应文本和对话元数据。
5. 为本地客户端提供健康检查、Cookie 管理和 completion 接口。

## 🚀 快速开始

### 1. 环境要求

- Rust stable（建议使用最新 stable toolchain）
- Cargo
- Node.js 18+（仅用于构建 Chrome 扩展）
- npm
- Chrome 或其他支持扩展加载的 Chromium 浏览器
- 一个已经登录 `https://gemini.google.com` 的 Google 账号

### 2. 启动 Rust 服务端

在项目根目录执行：

```bash
cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

默认监听：

```text
http://localhost:3456
```

也可以通过 `PORT` 修改端口：

```bash
PORT=3457 cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

如果网络需要代理，可以设置：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \\
  cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

生产或长期运行时可以先构建二进制：

```bash
cargo build --release --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
./GeminiWebAPIBridgeRust/target/release/GeminiWebAPIBridgeRust
```

### 3. 构建并加载 Chrome 扩展

安装依赖并构建扩展：

```bash
npm install
npm run build
```

然后打开 Chrome：

1. 访问 `chrome://extensions/`。
2. 开启右上角的 **Developer mode（开发者模式）**。
3. 点击 **Load unpacked（加载已解压的扩展程序）**。
4. 选择 WXT 构建生成的 `.output/chrome-mv3` 目录。
5. 打开 `https://gemini.google.com`，确认 Google 账号已经登录。
6. 点击扩展 Popup，打开 **Enable Bridge**。
7. 确认 **Server URL** 为 `http://localhost:3456`。
8. 点击 **Sync Cookies Now**，或者等待自动同步。
9. 点击 **Test**，确认服务端显示为 Connected。

如果扩展代码发生变化，可以使用开发模式：

```bash
npm run dev
```

### 4. 验证服务端状态

```bash
curl http://localhost:3456/health
```

服务端启动后，即使尚未同步 Cookie，也可以通过该接口确认进程是否正常运行。同步 Cookie 后，返回结果中的 `hasCookies` 应为 `true`；首次完成会话刷新后，`hasSession` 应为 `true`。

## 📡 HTTP API

### 健康检查

```http
GET /health
```

示例：

```bash
curl http://localhost:3456/health
```

返回字段包括：

- `status`：服务状态。
- `hasCookies`：是否已经收到扩展同步的 Cookie。
- `hasSession`：是否已经成功提取 Gemini Session Token。
- `lastCookieSync`：最近一次 Cookie 同步时间。
- `uptime`：服务端运行时间，单位为秒。

### 同步 Cookie

```http
POST /api/cookies
Content-Type: application/json
```

请求体支持 Cookie 字符串：

```json
{
  "cookies": "SID=...; __Secure-1PSID=..."
}
```

也支持 Cookie 对象数组：

```json
{
  "cookies": [
    { "name": "SID", "value": "..." },
    { "name": "__Secure-1PSID", "value": "..." }
  ]
}
```

通常不需要手动调用，扩展会自动完成同步。

### 查看 Cookie 状态

```http
GET /api/cookies/status
```

```bash
curl http://localhost:3456/api/cookies/status
```

### 强制刷新 Gemini Session

```http
POST /api/session/refresh
```

```bash
curl -X POST http://localhost:3456/api/session/refresh
```

正常情况下，completion 请求会在需要时自动刷新 Session；只有排查问题或验证登录状态时才需要手动调用此接口。

### 与 Gemini 交互

```http
POST /api/bridge/completions
Content-Type: application/json
```

使用 `prompt`：

```bash
curl -X POST http://localhost:3456/api/bridge/completions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "requestId": "demo-1",
    "prompt": "你好，请用中文介绍一下 Rust。"
  }'
```

也可以使用 `messages`：

```json
{
  "requestId": "demo-2",
  "messages": [
    { "role": "user", "content": "请解释什么是 Rust 的所有权。" }
  ]
}
```

典型返回：

```json
{
  "requestId": "demo-1",
  "text": "你好！Rust 是一种……",
  "conversationId": "conversation-key"
}
```

### 多轮对话

客户端需要为同一段对话指定稳定的 `conversationId`：

```json
{
  "requestId": "demo-3",
  "conversationId": "conversation-key",
  "prompt": "请再举一个实际例子。"
}
```

服务端会在内存中保存 Gemini 返回的对话上下文。重启 Rust 服务端后，这些上下文会丢失，需要重新开始对话。

## 🔧 Rust 项目命令

```bash
# 格式化
cargo fmt --manifest-path GeminiWebAPIBridgeRust/Cargo.toml

# 编译检查
cargo check --manifest-path GeminiWebAPIBridgeRust/Cargo.toml

# Debug 运行
cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml

# Release 构建
cargo build --release --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

## 🧪 端到端验证建议

在扩展已经启用且 Cookie 同步成功后，可以依次验证：

1. `GET /health`：确认服务端可访问。
2. `GET /api/cookies/status`：确认 `hasCookies` 为 `true`。
3. `POST /api/session/refresh`：确认 Gemini Session 参数可以提取。
4. `POST /api/bridge/completions`：发送一条中文测试消息。
5. 使用相同的 `conversationId` 再发一条消息，验证多轮对话。
6. 发送包含中文、换行符、引号和 JSON 的 Prompt，验证请求编码和响应解析。

## 🐛 常见问题

### `No cookies available` 或 `No cookies synced from extension`

- 确认已经登录 `gemini.google.com`。
- 确认扩展 Popup 中 **Enable Bridge** 已打开。
- 点击 **Sync Cookies Now**。
- 确认扩展中的 Server URL 与 Rust 服务端端口一致。
- 检查 `GET /api/cookies/status` 的 `hasCookies`。

### `Cannot extract SNlM0e token from Gemini page`

这通常表示 Cookie 已过期、账号未登录，或者 Gemini 页面结构发生变化。可以尝试：

1. 在浏览器中重新打开 Gemini 并确认可以正常发送消息。
2. 手动同步 Cookie。
3. 调用 `POST /api/session/refresh` 重试。
4. 重启 Rust 服务端后再次测试。

### 服务端无法连接 Gemini

检查网络和代理配置。Rust 服务端会读取以下环境变量：

```text
https_proxy
HTTPS_PROXY
http_proxy
HTTP_PROXY
```

### 扩展加载后状态异常

重新加载扩展，并重新打开 Gemini 页面。扩展重载后可能需要再次执行 Cookie 同步。

## 🔐 安全说明

- 浏览器 Cookie 等同于登录凭证，请勿提交到 Git、日志系统或公开渠道。
- 服务端默认监听 `0.0.0.0:3456`，建议仅在可信的本机或内网环境运行。
- 如果需要暴露到其他机器，请额外配置防火墙、反向代理和认证机制。
- 项目仅用于个人学习和研究，请遵守 Google Gemini 的服务条款及相关法律法规。

## 📁 目录结构

```text
.
├── GeminiWebAPIBridgeRust/
│   ├── Cargo.toml
│   └── src/
│       └── main.rs          # Rust Bridge Server
├── entrypoints/
│   ├── background.ts        # Cookie 提取与自动同步
│   └── popup/                # 扩展配置及状态界面
├── utils/types.ts            # 扩展消息和配置类型
├── wxt.config.ts             # WXT/Manifest 配置
├── package.json              # Chrome 扩展构建脚本
└── README.md
```

## 📄 许可证

本项目基于 MIT 许可证开源。

---

# Gemini Web API Bridge (English)

Gemini Web API Bridge uses a browser extension to synchronize cookies from an authenticated Gemini web session and a Rust server to call the Gemini Web API directly. It enables local clients to interact with Gemini without a Google AI Studio API key.

> The backend has been migrated from Node.js to Rust. The current Rust implementation supports cookie synchronization, Gemini session extraction, single-turn requests, and multi-turn conversations through `conversationId`.

## Features

- No Google AI Studio API key required.
- Rust backend built with Axum, Tokio, and Reqwest.
- Direct Gemini Web API access; no DOM scraping, page injection, or long polling.
- Automatic and manual browser-cookie synchronization.
- Automatic extraction and refresh of Gemini session parameters.
- Single-turn and multi-turn completion requests.
- `prompt` and `messages` request formats.
- HTTP proxy support through standard proxy environment variables.
- Browser popup for configuration and connection status.

## Quick Start

### Start the Rust server

```bash
cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

The default address is `http://localhost:3456`. To use another port:

```bash
PORT=3457 cargo run --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
```

For a release build:

```bash
cargo build --release --manifest-path GeminiWebAPIBridgeRust/Cargo.toml
./GeminiWebAPIBridgeRust/target/release/GeminiWebAPIBridgeRust
```

### Build and load the extension

```bash
npm install
npm run build
```

Load `.output/chrome-mv3` from `chrome://extensions/` with Developer mode enabled. Make sure you are logged in to `https://gemini.google.com`, enable the bridge in the popup, keep the server URL at `http://localhost:3456`, and click **Sync Cookies Now**.

Use `npm run dev` during extension development.

### Test the server

```bash
curl http://localhost:3456/health
curl http://localhost:3456/api/cookies/status
```

Then send a completion request:

```bash
curl -X POST http://localhost:3456/api/bridge/completions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "requestId": "demo-1",
    "prompt": "Hello, please introduce Rust in Chinese."
  }'
```

The completion endpoint also accepts `messages` and an optional stable `conversationId` for multi-turn conversations.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Server health and session status |
| `POST` | `/api/cookies` | Synchronize browser cookies |
| `GET` | `/api/cookies/status` | Inspect cookie and token status |
| `POST` | `/api/session/refresh` | Force Gemini session refresh |
| `POST` | `/api/bridge/completions` | Send a prompt to Gemini |

## Troubleshooting

If the server reports that cookies are unavailable, log in to Gemini, enable the extension, and manually synchronize cookies. If session extraction fails, refresh the Gemini page and call `/api/session/refresh` again. For connectivity problems, configure `HTTPS_PROXY` or another standard proxy environment variable.

## Security

Browser cookies are authentication credentials. Never commit or publicly share them. The server binds to `0.0.0.0:3456` by default, so use it only in a trusted environment or put authentication and network controls in front of it when exposing it beyond the local machine.

## ⚠️ License & Usage Terms (授权与使用协议)

本项目采用 **Source-Available License（公开源码专有协议）**：

1. **仅限个人学习与审计**：代码公开仅供个人学习、代码审查与技术评估。
2. **使用与商用需授权**：未经原作者显式书面许可，严禁将本项目（包含全部或部分代码）用于生产环境部署、实际业务运行、二次分发或商业运营。
3. **授权联系**：如需使用、部署或商业授权，请联系作者邮箱：`sjie13684@gmail.com`。

完整协议内容请查阅根目录 [LICENSE](./LICENSE) 文件。
