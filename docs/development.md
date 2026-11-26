[中文](development.md) · [English](development.en.md)

# Remote.Command 开发与本地联调部署指南

本文档面向开发者与本地测试场景，完整说明如何在本机搭建 **Gateway + Google OIDC + 本地 Agent + ChatGPT Remote MCP** 全链路测试环境。

> [!NOTE]
> 所有敏感环境变量、测试数据库与本地启动脚本均放在仓库 `.gitignore` 忽略的 `state/` 目录中，严禁将真实 `GOOGLE_CLIENT_SECRET`、Tunnel Token 或测试数据库提交到 Git。

---

## 1. 环境前提与源码准备

在仓库根目录确认本地环境并完成首次编译：

- **Node.js**：24–26（推荐与 CI 一致的 LTS / 当前版本）
- **npm** 与 **Git**
- 依赖编译（首次或拉取更新后）：

```bash
npm ci --include=dev --ignore-scripts
npm run build
```

如需运行自动化测试：

```bash
# 基础单元与端到端测试
npm test

# macOS / Linux 加测真实 TLS 与终端审批（需 OpenSSL 与 Python 3）
RCM_TEST_TLS=1 RCM_TEST_TTY=1 npm test
```

---

## 2. 本地访问方案选择（必读）

Gateway 对 `PUBLIC_ORIGIN` 有严格校验（见 [protocol.ts](../src/protocol.ts)）：

- 仅允许 **`https://`** 源；
- 仅在显式设置 `ALLOW_INSECURE_LOOPBACK=1` 时，放行 **`http://127.0.0.1:<port>`**（**不放行** `http://localhost:<port>`）。

而 Google Cloud Console 的 **Web 应用（Web application）** OAuth 客户端在填写回调地址时，通常要求域名或 `localhost`，可能拒绝纯 IP `http://127.0.0.1`。因此本地测试建议按场景二选一：

| 方案 | 适用场景 | 说明 |
| --- | --- | --- |
| **方案 A：本地 Gateway + HTTPS 隧道（推荐）** | 联调 Google 登录、本地 Agent 与 **ChatGPT Remote MCP 全链路** | 通过 Cloudflare Tunnel 将固定测试子域名（如 `https://dev-mcp.example.com`）转发至 `127.0.0.1:8787`，同时满足本项目的 HTTPS 校验、Google Web 应用回调限制与 ChatGPT 公网接入要求。 |
| **方案 B：纯本地明文回环 `http://127.0.0.1:8787`** | 仅本机快速调试后端/界面（不连 ChatGPT） | 需同时设置 `ALLOW_INSECURE_LOOPBACK=1` 且浏览器必须用 `127.0.0.1` 打开（不能混用 `localhost`，否则 OIDC state cookie 无法匹配）。本地 Agent 也需在配置中手动设置 `"allowInsecureLoopback": true`。 |

> [!TIP]
> 只需要 **1 个 Cloudflare Tunnel** 和 **1 个子域名**（如 `dev-mcp.example.com`）。控制台（`/manage`）、Google 回调（`/auth/google/callback`）、ChatGPT MCP（`/mcp`）与 Agent 接口（`/agent/*`）全部复用同一端口下的不同路径。

下面以最推荐的 **方案 A（Cloudflare Tunnel 固定子域名）** 为例分步说明；方案 B 的差异附在对应步骤之后。

---

## 3. 步骤 1：安装 `cloudflared` 并配置 Cloudflare Tunnel

### 3.1 安装 `cloudflared`（Windows / macOS / Linux）

仓库已内置跨平台脚本 [scripts/dev-local.mjs](../scripts/dev-local.mjs)（与封装入口 [scripts/dev-local.sh](../scripts/dev-local.sh) / [scripts/dev-local.ps1](../scripts/dev-local.ps1)），支持 **Windows (`amd64` / `386`)、macOS (`amd64` / `arm64`)、Linux (`amd64` / `arm64`)** 一键下载安装 Cloudflare 官方预编译二进制包到 `~/.local/bin/cloudflared`（Windows 为 `%USERPROFILE%\.local\bin\cloudflared.exe`），无需手动编译或配置包管理器：

- **macOS / Linux**：
  ```bash
  ./scripts/dev-local.sh install-tunnel
  # 强制更新到最新版：./scripts/dev-local.sh install-tunnel --force
  ```
- **Windows (PowerShell)**：
  ```powershell
  .\scripts\dev-local.ps1 install-tunnel
  # 强制更新到最新版：.\scripts\dev-local.ps1 install-tunnel --force
  ```

> [!TIP]
> 首次直接运行启动脚本时，如果本机尚未安装 `cloudflared`，也会自动触发下载安装。若偏好手动安装，可前往 [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases) 下载对应平台包。

### 3.2 在 Cloudflare Zero Trust 创建隧道

1. 登录 [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)。
2. 进入 **Networks** → **Tunnels** → **Create a tunnel**，类型选择 **Cloudflared**。
3. 为隧道命名（如 `rcm-dev`），保存并复制页面生成的 **Tunnel Token**（后续写入 `CLOUDFLARED_TUNNEL_TOKEN`）。
4. 在 **Public Hostname** 页面添加 **1 条** 路由规则：
   - **Subdomain**：`dev-mcp`
   - **Domain**：选择你在 Cloudflare 托管的主域名（如 `example.com`）
   - **Path**：**留空**（确保 `/manage`、`/auth/google/callback`、`/mcp`、`/oauth/*`、`/agent/*` 全部转发）
   - **Service Type**：`HTTP`
   - **URL**：`127.0.0.1:8787`

---

## 4. 步骤 2：配置 Google Cloud Console（Google Auth Platform）

1. **选择或新建项目**：打开 [Google Cloud Console](https://console.cloud.google.com/)，在顶部项目下拉框选择已有项目，或新建一个开发专用项目（如 `remote-command-dev`）。
2. **初始化 Google Auth Platform**：
   - 直达入口：https://console.cloud.google.com/auth （或左侧菜单 **API 和服务 → OAuth 同意屏幕**）。
   - 首次使用点击 **开始使用（Get started）**，按 4 步完成基础配置：
     1. **应用信息（App Information）**：应用名称填 `Remote.Command Dev`，用户支持邮箱选你自己的 Gmail。
     2. **目标群体（Audience）**：选择 **外部（External）**；保持 **测试（Testing）** 状态即可，个人/团队测试**无需**发布到生产或提交 Google 审核。
     3. **联系信息（Contact Information）**：填写开发者联系邮箱。
     4. **完成（Finish）**：勾选同意政策并创建。
3. **添加测试用户（必做）**：
   - 进入左侧 **目标群体（Audience）**（直达：https://console.cloud.google.com/auth/audience ）。
   - 在 **测试用户（Test users）** 栏点击 **+ 添加用户**，加入所有用于测试登录的 Gmail 地址并保存。
   - 若后续需要测试多租户「邀请码注册」，请将第二个测试 Gmail 也提前加入此处。
4. **创建 Web 应用 OAuth 客户端**：
   - 进入左侧 **客户端（Clients）**（直达：https://console.cloud.google.com/auth/clients ）。
   - 点击 **+ 创建客户端（Create client）**：
     - **应用类型（Application type）**：选择 **Web 应用（Web application）**
     - **名称**：`Remote.Command Dev`
     - **已获授权的重定向 URI（Authorized redirect URIs）**：**精确填写**（末尾无斜杠）：
       ```text
       https://dev-mcp.example.com/auth/google/callback
       ```
   - 创建后复制 **`Client ID`** 与 **`Client Secret`**。

> [!IMPORTANT]
> 本项目仅使用基础非敏感 scope（`openid email profile`），授权回调 URI 必须与 `PUBLIC_ORIGIN + "/auth/google/callback"` 逐字符一致，否则 Google 会拦截并返回 `Error 400: redirect_uri_mismatch`。

---

## 5. 步骤 3：准备本地环境变量与一键启动

### 5.1 从脱敏模板创建 `state/local-test.env`（不入库）

仓库根目录已提供脱敏模板 [local-test.env.example](../local-test.env.example)。在仓库根目录复制到 `.gitignore` 忽略的 `state/` 目录中：

- **macOS / Linux**：
  ```bash
  install -d -m 0700 state
  cp local-test.env.example state/local-test.env
  chmod 600 state/local-test.env
  ```
- **Windows (PowerShell)**：
  ```powershell
  New-Item -ItemType Directory -Force state | Out-Null
  Copy-Item local-test.env.example state\local-test.env
  ```

编辑 `state/local-test.env`，填入你的真实配置：

- `PUBLIC_ORIGIN`：如 `"https://dev-mcp.example.com"`（必须与 Google 回调和 Cloudflare Public Hostname 一致）
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`：Google Cloud Console 获取的 Web 应用凭证
- `ADMIN_GOOGLE_EMAILS`：你的管理员 Google 邮箱
- `CLOUDFLARED_TUNNEL_TOKEN`：Cloudflare Zero Trust Dashboard 获取的 Tunnel Token
- 若本机访问 `accounts.google.com` 需要 HTTP 代理，取消注释并配置 `NODE_USE_ENV_PROXY="1"` 与 `HTTPS_PROXY`

<details>
<summary>方案 B（纯本地明文）环境变量差异</summary>

将 `PUBLIC_ORIGIN` 改为 `"http://127.0.0.1:8787"`、新增 `ALLOW_INSECURE_LOOPBACK="1"`、`TRUST_PROXY="0"`，并留空 `CLOUDFLARED_TUNNEL_TOKEN` 后运行 `gateway` 子命令（需确保所使用的 OAuth Client 允许回环回调，且浏览器只访问 `http://127.0.0.1:8787/manage`）。

</details>

### 5.2 使用仓库跨平台脚本一键启动

- **macOS / Linux**：
  ```bash
  # 安装隧道（如尚未安装，启动 all/tunnel 时也会自动安装）
  ./scripts/dev-local.sh install-tunnel

  # 一键同时启动 Cloudflare Tunnel 与本地 Gateway（按 Ctrl+C 一并停止）
  ./scripts/dev-local.sh

  # 分开调试：
  ./scripts/dev-local.sh tunnel
  ./scripts/dev-local.sh gateway
  ```
- **Windows (PowerShell)**：
  ```powershell
  # 安装隧道（如尚未安装，启动 all/tunnel 时也会自动安装）
  .\scripts\dev-local.ps1 install-tunnel

  # 一键同时启动 Cloudflare Tunnel 与本地 Gateway（按 Ctrl+C 一并停止）
  .\scripts\dev-local.ps1

  # 分开调试：
  .\scripts\dev-local.ps1 tunnel
  .\scripts\dev-local.ps1 gateway
  ```

> 安全细节：脚本通过环境变量 `TUNNEL_TOKEN` 向 `cloudflared` 传递隧道令牌（不会暴露在 `ps` / 命令行参数中），并在启动 `node dist/gateway.js` 时主动剥离该变量。若 `dist/gateway.js` 尚未编译，脚本会自动先执行 `npm run build`。

---

## 6. 步骤 4：联调与验收清单

1. **健康检查**：
   - 访问 `https://dev-mcp.example.com/readyz`，确认返回 `200`。
   - 访问 `https://dev-mcp.example.com/.well-known/oauth-protected-resource/mcp`，确认返回的 `resource` 为 `https://dev-mcp.example.com/mcp`。
2. **Google 登录与首个管理员初始化**：
   - 浏览器访问 `https://dev-mcp.example.com/manage`，点击 **使用 Google 账号继续**。
   - 完成 Google 授权后，确认成功进入控制台且当前身份为管理员（`role: admin`）。
3. **多租户与注册策略（可选验证）**：
   - 在 **成员与邀请** 页面查看管理员切换的注册模式（`invite` 仅邀请码 / `open` 开放 / `closed` 关闭），生成一个邀请码并使用第二个 Test User Google 账号完成激活，确认各自设备列表完全隔离。
4. **本地 Agent 配对与工具调用**：
   - 准备一个独立的测试工作区目录（不得是 `$HOME`、根目录或仓库自身目录，见 [agent-config.ts](../src/agent-config.ts)）：

```bash
mkdir -p /tmp/rcm-test-workspace
node dist/remote-cli.js remote \
  --config "$HOME/.remote-command/agent-local-test.json" \
  --gateway "https://dev-mcp.example.com" \
  --workspace "/tmp/rcm-test-workspace" \
  --allow "read,write,exec"
```

   - 若使用方案 B（`http://127.0.0.1:8787`），需手写配置并加入 `"allowInsecureLoopback": true`（且 `stateDir` 权限为 `0700`）后再运行 `node dist/remote-cli.js remote --config <path>`。
5. **ChatGPT Remote MCP 联调**：
   - 在 ChatGPT 中添加 MCP Server URL：`https://dev-mcp.example.com/mcp`，认证选 **OAuth**（DCR `/oauth/register` 自动注册，无需手填 Client ID/Secret）。
   - 在授权页直接点击 **继续（使用当前 Google 账号）** 完成授权，对话中依次调用 `who_am_i`、`list_devices` 与一次读写/审批操作确认全链路畅通。

---

## 7. 常见问题排查

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| Google 页面提示 `403 access_denied` / 应用未完成验证 | Google Auth Platform 处于 Testing 状态且当前 Gmail 未加入 Test users | 在 Console → **目标群体（Audience）** → **Test users** 添加该邮箱后重试 |
| Google 页面报错 `400 redirect_uri_mismatch` | `PUBLIC_ORIGIN` 与 Console 中填写的重定向 URI 不完全一致（多斜杠、协议或子域名差异） | 核对 Console 为 `https://<PUBLIC_ORIGIN域名>/auth/google/callback`，且 `PUBLIC_ORIGIN` 无尾部 `/` |
| 回调返回 `502 无法从 Google 换取登录令牌` | Gateway 后端访问 `accounts.google.com` 或 `oauth2.googleapis.com` 被本地网络阻断或超时 | 在 `state/local-test.env` 开启 `NODE_USE_ENV_PROXY="1"` 与 `HTTPS_PROXY` |
| 回调报「登录状态校验失败或已过期」 | 方案 B 下混用了 `localhost` 和 `127.0.0.1`，导致浏览器未带回 OIDC state cookie；或隧道域名重启后变化 | 方案 B 全程固定使用 `http://127.0.0.1:<PORT>`；方案 A 使用固定域名 |
| `Gateway startup aborted: missing required Google OAuth...` | 未加载 `state/local-test.env` 或 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 为空 | 检查环境变量并确保使用 `set -a && source ... && set +a` 启动 |
| Agent 提示目录隔离校验失败 | `workspace` 设成了 `$HOME`、磁盘根目录，或包含了 `agent.json` / `stateDir` / 仓库目录 | 为测试新建独立目录（如 `/tmp/rcm-test-workspace`），并将配置与状态目录放在其外 |
