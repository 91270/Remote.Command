# Remote.Command 生产运维指南

本文档面向单管理员生产环境部署，涵盖 **Gateway 首次部署、离线镜像导入、版本升级与回退、Agent 后台服务托管、在线备份恢复与日常巡检**。

> [!NOTE]
> 宿主机 Nginx 负责公网域名和 HTTPS。Gateway 使用 GitHub Container Registry 上的镜像，端口映射到 `127.0.0.1:8787`。SQLite 数据存放在宿主机目录 `RCM_DATA_DIR`，默认是 `compose.yaml` 同目录下的 `./data`。

---

## 1. 首次部署

准备一台安装了 Docker Compose 和 Nginx 的 Linux 服务器。将域名解析到这台服务器，并在 Nginx 准备对应证书。公网客户端访问 HTTPS `443`。

1. 将当前 [compose.yaml](../compose.yaml) 保存到服务器的部署目录。包含独立 `remote-command-<版本>-compose.yaml` 的 Release 也可直接下载该文件并保存为 `compose.yaml`。如果 GHCR 包为私有，先用具备 `read:packages` 权限的账号执行 `docker login ghcr.io`。
2. 在同目录设置 `.env`，权限设为 `0600`。以下值按实际域名、凭证和持久化路径填写。

```dotenv
PUBLIC_ORIGIN=https://mcp.example.com
RCM_DATA_DIR=/srv/remote-command/data
OAUTH_CLIENT_ID=rcm_chatgpt
OAUTH_CLIENT_SECRET=<生成一个43字符的密钥>
OWNER_KEY=<另外生成一个43字符的密钥>
```

   `PUBLIC_ORIGIN` 填 Nginx 站点对外的 HTTPS 地址。Gateway 用该值生成 OAuth 元数据和设备配对链接。可以在任一装有 OpenSSL 的机器执行 `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` 两次，分别生成客户端密钥和管理员密钥。ChatGPT 提供专用 OAuth 回调地址时，另设 `OAUTH_REDIRECT_URIS`。

3. 启动 Gateway。首次启动自动拉取镜像，并初始化空的宿主机数据目录。已有目录需要归属容器用户 `1000:1000`，权限为 `0700`。初始化只调整空的 root 所有目录，遇到已有内容且权限不匹配时会退出。

```sh
docker compose up -d --wait
```

4. 将 [Nginx 站点示例](../deploy/nginx/remote-command.conf) 放到宿主机 Nginx 已启用的站点配置目录。修改 `server_name`、`ssl_certificate` 和 `ssl_certificate_key`，使域名与 `.env` 的 `PUBLIC_ORIGIN` 一致。站点保留完整 URI，将 `/mcp`、OAuth、Agent 接口和 `/manage` 统一转发到 `127.0.0.1:8787`。示例的 `40m` 请求体上限与 Gateway 同步接口一致。

   以使用 systemd 且包含 `/etc/nginx/conf.d/*.conf` 的服务器为例，放置并编辑配置后执行下面的命令。

```sh
sudo nginx -t && sudo systemctl reload nginx
```

5. 从宿主机检查 `http://127.0.0.1:8787/readyz`，再从客户端检查 `https://mcp.example.com/readyz`。确认 `https://mcp.example.com/.well-known/oauth-protected-resource/mcp` 返回的 `resource` 使用实际 HTTPS 域名。打开 `/manage`，使用 `.env` 中的 `OWNER_KEY` 登录，然后按 [README 快速开始](../README.md#第二步在目标电脑启动-agent) 安装 Agent 并接入 ChatGPT。

---

## 2. 离线镜像与维护者构建

### 使用离线镜像包

以 `0.4.1` 为例，校验并导入 `linux/amd64` 离线镜像后，在 `.env` 中设置 `RCM_GATEWAY_IMAGE=remote-command:0.4.1`。部署其他版本时，将镜像文件名和标签替换为对应版本。

```sh
docker image load -i remote-command-0.4.1-gateway-linux-amd64.tar.gz
docker compose up -d --pull never --wait
```

### 从源码目录直接构建

维护者可在源码根目录构建镜像，并用 `RCM_GATEWAY_IMAGE` 指定本地镜像做验证。

```sh
docker build -t remote-command:local .
RCM_GATEWAY_IMAGE=remote-command:local docker compose up -d --pull never --wait
```

---

## 3. 升级与回退

1. **备份先行**：升级前先执行在线备份并校验备份文件（见第 6 节），同时保留旧版本镜像、部署文件与 `.env` 副本。
2. **原地更新**：在原部署目录更新 Compose 文件，或在 `.env` 中通过 `RCM_GATEWAY_IMAGE` 指定新镜像。保留 `RCM_DATA_DIR`，执行 `docker compose up -d --wait`。Gateway 启动时会自动执行数据库迁移。
3. **升级验收**：等待 `/readyz` 返回成功，在 ChatGPT 中对已配对设备执行一次读取、一次需本机确认的操作和一次后台任务，核对结果正常。
4. **回退处理**：若旧版本镜像不兼容新版数据库结构，请将升级前的备份快照恢复到一个新数据库路径（见第 6 节），再切回旧镜像启动。

### 从旧版命名卷迁移到宿主机目录

1. 保留原 Compose、`.env` 和 `gateway-data` 卷。安排维护窗口暂停调用，按第 6 节导出并校验旧 Gateway 的 SQLite 快照，再用旧 Compose 停止 Gateway。旧版若使用 Caddy，同时保留 `Caddyfile` 并停止 Caddy。
2. 将快照文件直接复制到全新的宿主机数据目录。这条迁移路径保留原配对和 OAuth 会话。第 6 节的 `restore` 命令用于灾难恢复，会撤销这些授权。

```sh
data_dir=/srv/remote-command/data
sudo mkdir -p -- "$(dirname "$data_dir")"
sudo mkdir -m 0700 -- "$data_dir" &&
  sudo chown 1000:1000 "$data_dir" &&
  sudo install -m 0600 -o 1000 -g 1000 /private/backups/rcm-2026-11-19.sqlite "$data_dir/gateway.sqlite"
```

3. 在原部署目录换入当前 Compose。设置 `RCM_DATA_DIR` 指向新目录，`STATE_DB` 沿用默认 `/data/gateway.sqlite`，域名和 OAuth 配置继续沿用。执行 `docker compose up -d --wait --remove-orphans`。按第 1 节配置或重载 Nginx，再验证已配对设备是否在线。

---

## 4. 构建与发布产物

从源码生成完整发布产物需要 **Node.js 24–26**、`npm` 与 `tar`；附加 `--with-image` 时还需本机安装 Docker：

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-0.4.1-SHA256SUMS
```

也可在 GitHub Actions 中手动触发 **Verify** 工作流并勾选发布选项。测试全部通过后，工作流将 Gateway 镜像推送至 GHCR，并在 GitHub Release 上传独立 Compose 文件、Agent 安装包、部署包、离线镜像与 SHA-256 清单。

---

## 5. Agent 安装与后台服务托管

将 Agent 解包到当前用户管理的固定目录并按锁文件安装依赖，即可注册为系统用户级后台服务（开机/登录自启）：

### macOS / Linux

```sh
rcm_client="$HOME/.remote-command/client-0.4.1"
mkdir -p "$rcm_client"
tar -xzf /path/to/remote-command-0.4.1.tgz -C "$rcm_client" --strip-components=1
(cd "$rcm_client" && npm ci --omit=dev --ignore-scripts)

# 1. 先在前台完成首次交互式配对，成功后按 Ctrl+C 退出
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

备份文件包含设备配对记录、工具结果与审计历史，**请仅限管理员读写，并在异机保留加密副本**。`.env` 和宿主机 Nginx 站点配置应单独备份。

### 在线备份与校验

在部署目录执行以下命令。从容器在线导出 SQLite 快照，校验通过后写入最终备份文件，已有同名文件会保留。

```sh
(
  umask 077
  backup=/private/backups/rcm-2026-11-19.sqlite
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
  node dist/admin.js restore < /private/backups/rcm-2026-11-19.sqlite
```

2. 在维护窗口将 `.env` 中的 `STATE_DB` 修改为 `/data/gateway-recovered.sqlite`，重启 Gateway：

```sh
docker compose up -d --wait gateway
```

> [!IMPORTANT]
> 恢复操作会保留已完成调用的结果与审计记录，但会**清除 OAuth 会话、管理页会话和待用邀请**，将所有设备标为已撤销、进行中的任务标为已中断。恢复完成后请重新配对设备并授权 ChatGPT，同时检查原设备是否有旧进程仍在运行。

---

## 7. 日常巡检清单

| 检查项 | 验证方式与说明 |
| --- | --- |
| **服务健康** | `/healthz`（存活）与 `/readyz`（数据库可访问）均返回 `200`。 |
| **HTTPS 与 OAuth** | 确认 TLS 证书有效，且 `/.well-known/oauth-protected-resource/mcp` 中的资源 URI 指向你的 HTTPS Gateway。 |
| **日志与磁盘** | 执行 `docker compose logs --tail 100 gateway`，按宿主机配置查看 Nginx 日志，并检查磁盘与备份空间。 |
| **数据保留策略** | 已结束任务默认保留 **7 天**，审计日志默认保留 **90 天**，可通过 `RCM_TASK_RETENTION_DAYS` 与 `RCM_AUDIT_RETENTION_DAYS` 调整（累计调用统计跨清理保留）。 |
| **紧急撤销与诊断** | 在 `/manage` 控制台可撤销单台/全部设备或单独撤销 ChatGPT 授权（批量撤销会作废现有配对码与邀请）；客户端排查可使用 `remote --report --no-upload` 导出脱敏诊断包。 |

真实域名生产验收建议覆盖：外网 TLS 证书、真实 ChatGPT 账号接入、一次读操作、一次本机审批操作、一次后台任务查询及一次备份恢复演练。当前已验证环境与待测项见 [验收记录](verification.md)。
