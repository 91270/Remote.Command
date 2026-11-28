[中文](production.md) · [English](production.en.md)

# Remote.Command 生产部署与运维指南

本文档面向单实例或多租户生产环境部署，涵盖 **Gateway 首次部署（Google OIDC + Docker Compose + HTTPS）、离线镜像导入、版本升级与回退、构建发布、Agent 后台服务托管、在线备份恢复与日常巡检**。本地开发环境搭建请见 [开发环境指南](development.md)。

> [!NOTE]
> 宿主机 Nginx（或反代边缘）负责公网域名和 HTTPS TLS 终止；Gateway 使用 GitHub Container Registry（GHCR）上的官方容器镜像，监听 `8787`。SQLite 状态与轮转日志存放在 Compose 的 `volumes.source` 宿主机目录（默认 `./data`）。

---

## 1. 首次部署

### 1.1 架构与前置准备

准备一台已安装 **Docker Engine / Docker Compose** 与 **Nginx**（或等效 HTTPS 反向代理）的 Linux 服务器：

- 将一个独立生产域名（如 `mcp.example.com`，**建议与开发测试子域名分开**）解析到该服务器。
- 为宿主机 Nginx 申请并配置好 TLS 证书（例如 Let's Encrypt），确保公网统一通过 HTTPS `443` 访问。

### 1.2 配置生产环境 Google OAuth 2.0

Gateway 已统一采用 **Google OIDC** 鉴权，不再使用本地账号密码，因此启动前必须先准备好 Google OAuth 凭证：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 进入 **Google Auth Platform**（`https://console.cloud.google.com/auth`）。
   - **建议为生产环境单独新建 Web 应用 OAuth Client**（与本地开发客户端隔离）。
2. 在 **客户端（Clients）→ 创建客户端（Web 应用）** 中填写：
   - **已获授权的重定向 URI（Authorized redirect URIs）**：精确填写（无尾部斜杠）：
     ```text
     https://mcp.example.com/auth/google/callback
     ```
3. 记录 **`Client ID`** 与 **`Client Secret`**。
4. **目标群体（Audience）状态选择**：
   - **仅限自己或固定白名单成员使用**：保持 **测试（Testing）** 状态，把允许登录的 Gmail 加入 **Test users（测试用户）**，无需提交 Google 审核。
   - **需面向任意公众 Google 账号开放**：在 Google Auth Platform 完善 **Branding（品牌信息、域名验证与隐私政策链接）** 后点击发布到 **In Production**；本项目仅请求基础非敏感 scope（`openid email profile`）。

### 1.3 准备部署目录、环境变量与启动 Gateway

1. 在服务器创建专用部署目录，并保存仓库中的 [compose.yaml](../compose.yaml)（包含独立 `remote-command-<版本>-compose.yaml` 的 Release 也可直接下载重命名为 `compose.yaml`）。若 GHCR 镜像包为私有，先用具备 `read:packages` 权限的账号执行 `docker login ghcr.io`。

2. 参考模板 [deploy/production.env.example](../deploy/production.env.example)，在与 `compose.yaml` 同目录创建受保护的 `.env` 文件（Docker Compose 会自动读取，**切勿将真实密钥直接硬编码进版本控制中的 YAML 或提交到 Git**）：

```sh
cp deploy/production.env.example .env && chmod 600 .env
# 编辑 .env，填入生产 PUBLIC_ORIGIN、GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、ADMIN_GOOGLE_EMAILS 与 TRUST_PROXY=1
```

   - **`ADMIN_GOOGLE_EMAILS`（强烈建议填写）**：指定首个允许初始化注册为管理员的 Google 邮箱（多个用英文逗号分隔）。若留空，空库状态下第一个完成 Google 登录的人将成为管理员。
   - **`TRUST_PROXY=1`**：容器运行在宿主机 Nginx 反向代理之后时开启，确保速率限制器依据 `X-Forwarded-For` / `X-Real-IP` 识别真实来源 IP。
   - **端口映射安全建议**：默认 `compose.yaml` 使用 `"8787:8787"`；若宿主机已通过本机 Nginx 终止 TLS，建议改为 `"127.0.0.1:8787:8787"`，避免公网绕过 HTTPS 直线访问 `8787`。
   - **OAuth DCR**：ChatGPT 与 Codex 会通过 `/.well-known/oauth-*` 与 `/oauth/register` 自动完成动态客户端注册，无需再手动配置静态 `OAUTH_CLIENT_ID` 或 `OAUTH_REDIRECT_URIS`。

3. 准备宿主机数据目录。Gateway 容器默认以 UID/GID `1000:1000` 运行，必须确保该目录权限正确（命令以默认 `./data` 为例）：

```sh
sudo install -d -m 0700 -o 1000 -g 1000 ./data
```

4. 启动 Gateway。Compose 会拉取镜像并初始化 SQLite（`data/gateway.sqlite`）及内部凭据文件（`data/.owner_key` 等，权限 `0600`，容器重建后保持复用）：

```sh
docker compose up -d --wait
```

   查看启动日志确认无缺失环境变量报错且处于等待首个管理员登录状态：

```sh
docker compose logs --tail 50 gateway
```

### 1.4 配置宿主机 Nginx 与 HTTPS

1. 将 [Nginx 站点示例](../deploy/nginx/remote-command.conf) 复制到宿主机 Nginx 已启用站点目录（如 `/etc/nginx/conf.d/remote-command.conf`），将 `server_name`、`ssl_certificate`、`ssl_certificate_key` 替换为你的生产域名与证书路径。
2. 示例已包含以下关键配置：
   - `client_max_body_size 40m;`：与 Gateway 的 40 MiB 同步体积上限一致。
   - `proxy_buffering off;`、`proxy_cache off;`、`proxy_read_timeout 65s;`：保障 MCP 流式响应与 25s `/device/sync` HTTP Long Polling 长连接稳定透传不超时。
   - 完整保留 `Host`、`X-Forwarded-Proto`、`X-Forwarded-For`、`X-Real-IP` 请求头。
3. **宝塔等面板用户必看**：若已有通用静态规则（如 `location ~ \.well-known`），会截获 OAuth 自动发现请求并返回 404，务必添加优先前缀规则将 `/.well-known/oauth-` 转发给 Gateway：

```nginx
location ^~ /.well-known/acme-challenge/ { allow all; }
location ^~ /.well-known/oauth- {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

4. 校验并重载 Nginx：

```sh
sudo nginx -t && sudo systemctl reload nginx
```

### 1.5 首次初始化与生产验收

1. 本机与公网连通性验证：
   - 宿主机：`curl -fsS http://127.0.0.1:8787/readyz`
   - 公网客户端：`curl -fsS https://mcp.example.com/readyz`
   - 确认 `https://mcp.example.com/.well-known/oauth-protected-resource/mcp` 返回的 `resource` 为 `https://mcp.example.com/mcp`。
2. **完成首个管理员登录**：浏览器打开 `https://mcp.example.com/manage`，点击 **使用 Google 账号继续**，使用 `ADMIN_GOOGLE_EMAILS` 指定的 Google 账号完成注册与登录。
3. **确认注册策略**：进入控制台 **成员与邀请**，按需设置新用户注册模式（默认 `invite` 仅凭管理员生成的邀请码注册，也可改为 `closed` 关闭或 `open` 开放）。
4. **接入设备与 ChatGPT**：按 [README 快速开始](../README.md#第二步在目标电脑启动-agent) 在目标电脑安装同版本 Agent 并配对，然后在 ChatGPT 添加 `https://mcp.example.com/mcp`（OAuth 自动发现接入）。

---

## 2. 离线镜像与维护者构建

### 使用离线镜像包

以特定版本离线包为例，导入 `linux/amd64` 离线镜像后，将 Compose 的 `image` 改为对应本地 tag：

```sh
docker image load -i remote-command-<version>-gateway-linux-amd64.tar.gz
docker compose up -d --pull never --wait
```

### 从源码目录直接构建

维护者可在源码根目录直接构建本地镜像，将测试环境 Compose 的 `image` 设为 `remote-command:local` 后启动：

```sh
docker build -t remote-command:local .
docker compose up -d --pull never --wait
```

---

## 3. 升级与回退

1. **备份先行**：升级前执行在线备份并校验备份文件（见第 6 节），同时保留现用镜像标签、Compose 配置、`.env` 和密钥文件。
2. **更新镜像**：更新 `compose.yaml` 中的 `image` 版本号，保持同一个宿主机 `./data` 目录与 `.env`，执行：

```sh
docker compose pull && docker compose up -d --wait
```

3. **升级验收**：等待 `/readyz` 返回成功、检查 `/manage` Google 登录状态正常，并在 ChatGPT 中对已配对设备执行一次读取、一次需本机确认的操作和一次后台任务，核对结果正常。
4. **回退处理**：需要回退数据时，将升级前的 SQLite 快照恢复到新数据库路径（见第 6 节），并恢复对应镜像版本与 Compose 配置。

---

## 4. 构建与发布产物

从源码生成完整发布产物需要 **Node.js 24–26**、`npm` 与 `tar`；附加 `--with-image` 时还需本机安装 Docker：

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-<version>-SHA256SUMS
```

也可在 GitHub Actions 中手动触发 **CI & Release** 工作流并勾选发布选项。测试全部通过后，工作流将 Gateway 镜像推送至 GHCR，并在 GitHub Release 上传独立 Compose 文件、Agent 安装包、部署包、离线镜像与 SHA-256 清单。

---

## 5. Agent 安装与后台服务托管

### 一键安装并启用后台常驻（推荐）

首次通过 Gateway 安装脚本或 CLI 接入设备时，可直接附加 `--install-service`（Windows PowerShell 使用 `?service=1`），在配对完成后自动安装并启动当前用户级后台常驻服务，并打印可用的启停与状态管理命令：

```sh
# macOS / Linux
curl -fsSL https://mcp.example.com/install.sh | bash -s -- --install-service

# 或在已安装 CLI 中执行
remote-command remote --gateway https://mcp.example.com --install-service
```

```powershell
# Windows：在控制台「添加设备」下载 remote-windows.cmd 双击运行，或执行以下 PowerShell（自动创建桌面快捷方式可选 ?shortcut=1）
irm 'https://mcp.example.com/install.ps1?service=1' | iex
# 或下载双击安装器：https://mcp.example.com/install/remote-windows.cmd?service=1
```

### 手动解包与独立服务注册

将 Agent 解包到当前用户管理的固定目录并按锁文件安装依赖，也可手动注册为系统用户级后台服务（开机/登录自启）：

### macOS / Linux

```sh
rcm_client="$HOME/.remote-command/client"
mkdir -p "$rcm_client"
tar -xzf /path/to/remote-command-<version>.tgz -C "$rcm_client" --strip-components=1
(cd "$rcm_client" && npm ci --omit=dev --ignore-scripts)

# 1. 先在前台完成首次交互式配对（用你的 Google 账号完成确认），成功后按 Ctrl+C 退出
node "$rcm_client/dist/remote-cli.js" remote

# 2. 注册并启动后台服务（若使用自定义配置路径，请替换最后一个参数）
node "$rcm_client/dist/remote-cli.js" service install "$HOME/.remote-command/agent.json"
```

### Windows（PowerShell）

在固定目录中使用 `tar.exe` 解包并执行相同的 `npm ci --omit=dev --ignore-scripts`，随后使用 `node` 调用解包目录下的 `dist\remote-cli.js` 完成配对与 `service install`。

### 平台服务机制与管理命令

| 平台 | 后台服务机制 | 前置要求 |
| --- | --- | --- |
| **macOS** | `LaunchAgent` | 当前用户会话 |
| **Linux** | `systemd` 用户服务 | 可用的 `systemd --user` 会话 |
| **Windows** | Task Scheduler（当前用户登录触发） | 桌面版 PowerShell 与当前用户任务写入权限 |

- **服务子命令**：`service` 支持 `install`、`render`、`status`、`start`、`stop`、`remove`，均需传入安装时使用的配置文件路径。
- **平滑升级**：将新版 `.tgz` 解包到新目录并 `npm ci` 后，先 `remove` 旧服务，再用新目录 CLI 指向原配置文件执行 `service install`（旧目录可保留作回退）。
- **安全与运行说明**：后台服务的身份、日志与敏感操作审批均归属当前操作系统用户，并遵循系统睡眠设置；退出配对或撤销设备后后台 Agent 会自动停止。

---

## 6. 在线备份与恢复演练

备份文件包含用户、设备配对、审计历史以及尚未过期的近期工具结果，请仅限管理员读写，并在异机保留加密副本。Gateway 默认在任务结束 **30 分钟**（`RCM_RESULT_TTL_MINUTES`）后自动清空任务正文（`args` / `output` / `mcp_result`），有效缩短敏感正文在备份中的暴露窗口。SQLite 快照之外，还需单独备份 `.env`、`data/.owner_key`、Compose 和 Nginx 配置。

### 在线备份与校验

在部署目录执行以下命令。从容器在线导出 SQLite 快照，校验通过后原子写入最终备份文件，已有同名文件会保留：

```sh
(
  umask 077
  backup=/private/backups/rcm-$(date +%F).sqlite
  temporary=$(mktemp "$backup.XXXXXX") || exit
  trap 'rm -f -- "$temporary"' EXIT
  docker compose exec -T gateway node dist/admin.js backup > "$temporary" &&
    docker compose exec -T gateway node dist/admin.js verify-backup < "$temporary" &&
    ln -T -- "$temporary" "$backup"
)
```

### 恢复流程

为避免覆盖现网数据，恢复操作会写入**新的数据库路径**（目标文件若已存在将拒绝恢复，中断后可使用同一快照重试）：

```sh
# 1. 将备份导入新路径
docker compose run --rm --no-deps -T -e STATE_DB=/data/gateway-recovered.sqlite gateway \
  node dist/admin.js restore < /private/backups/rcm-YYYY-MM-DD.sqlite
```

2. 在维护窗口给 Compose 的 `gateway.environment` 增加 `STATE_DB: /data/gateway-recovered.sqlite`，然后重启 Gateway：

```sh
docker compose up -d --wait gateway
```

> [!IMPORTANT]
> 恢复操作会保留用户账号、已完成调用的结果与审计记录，但会**清除所有登录会话、OAuth 会话和待用邀请**，将所有设备标为已撤销、进行中的任务标为已中断。恢复完成后请重新通过 Google 登录 `/manage`、重新配对设备并重新授权 ChatGPT，同时检查原设备是否有旧进程仍在运行。

---

## 7. 日常巡检清单

| 检查项 | 验证方式与说明 |
| --- | --- |
| **服务健康** | `/healthz`（存活）与 `/readyz`（数据库可访问）均返回 `200`。 |
| **HTTPS 与 OAuth** | 确认 TLS 证书有效，`/.well-known/oauth-protected-resource/mcp` 指向你的 HTTPS Gateway，且 `/auth/google/start` 能正常重定向到 Google 授权页。 |
| **日志与磁盘** | 执行 `docker compose logs --tail 100 gateway`，查看限流或上游 OIDC 错误；检查宿主机 Nginx 日志与备份磁盘空间。 |
| **数据保留策略** | 终态任务正文（`args` / `output` / `mcp_result`）默认保留 **30 分钟**（`RCM_RESULT_TTL_MINUTES`，设为 `0` 可关闭提前清理），到期后仅保留任务元数据（默认 **7 天**，`RCM_TASK_RETENTION_DAYS`）；脱敏用量元数据（`usage_events`，不含参数与输出正文）默认保留 **210 天**以支撑近 6 个月趋势统计，审计日志默认保留 **90 天**（`RCM_AUDIT_RETENTION_DAYS`），DCR 注册客户端默认保留 **30 天**（`RCM_DCR_CLIENT_TTL_DAYS`），均可在环境配置中调整。 |
| **长轮询与背压策略** | `/device/sync` 默认启用 **HTTP Long Polling**（`RCM_LONG_POLL_MS=25000`，兼容旧版短轮询 Agent），Gateway 同步等待窗口默认 **15 秒**（`RCM_SYNC_WAIT_MS=15000`），长任务执行租约默认 **6 分钟**并由 Agent 自动续期（`RCM_TASK_LEASE_MS=360000`）；多租户按用户默认并发上限 `RCM_MAX_USER_ACTIVE=8`、排队上限 `RCM_MAX_USER_WAITING=128`。 |
| **月度软配额告警** | 可选配置 `RCM_MONTHLY_SOFT_QUOTA`（正整数；未配置或 `0` 表示关闭）。当月调用量达到 **80%** 阈值时，`/manage` 控制台与 `who_am_i` 工具将返回非阻断软告警（默认不阻断任何自建工具调用）。 |
| **Free / Pro 套餐与兑换码** | 普通用户默认为 **Free（10,000 次有效设备调用/月，每月 1 日 00:00 UTC 重置）**；到达设备并完成执行的工具/资源调用计 1 次，控制工具与失败超时不计次。达 80% 返回提醒，达 100% 暂停新设备调用（保持设备配对不断开，`who_am_i` / `list_devices` 仍可用）。用户可在 `/manage`「套餐与计费」输入 **Pro 兑换码**（月卡/季卡/年卡/永久卡）自助升级，限时 Pro 到期自动降级回 Free。 |
| **管理员后台治理** | `role = admin` 账号登录 `/manage` 后可使用专属「管理后台」分组（全站概览、用户与套餐、邀请码与兑换码、全站设备与审计、系统策略），支持用户启停、强制踢下线、一键调整套餐/单用户配额、批量生成与作废邀请码/Pro 兑换码、跨租户紧急撤销设备以及在线调整注册策略、Free 默认配额与正文保留时长（所有 `/manage/api/admin/*` 接口对非管理员返回 `403`）。 |
| **紧急撤销与诊断** | 控制台 `/manage` 可按用户撤销单台设备、全部设备或 OAuth 授权，管理员还可停用异常成员账号；客户端可使用 `remote --report` 导出脱敏诊断包。 |

真实域名生产验收建议覆盖：外网 TLS 证书、真实 Google OIDC 管理员与邀请用户登录、真实 ChatGPT 账号接入、一次读操作、一次本机审批操作、一次后台任务查询及一次备份恢复演练。当前已验证环境与待测项见 [验收记录](verification.md)。
