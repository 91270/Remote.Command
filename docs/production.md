# Remote.Command 生产运维指南

本文档面向单管理员生产环境部署，涵盖 **Gateway 首次部署、离线镜像导入、版本升级与回退、Agent 后台服务托管、在线备份恢复与日常巡检**。

> [!NOTE]
> 宿主机 Nginx 负责公网域名和 HTTPS。Gateway 使用 GitHub Container Registry 上的镜像，端口映射到 `127.0.0.1:8787`。SQLite 存放在 Compose 的 `volumes.source` 指定的宿主机目录，默认是 `./data`。

---

## 1. 首次部署

准备一台安装了 Docker Compose 和 Nginx 的 Linux 服务器。将域名解析到这台服务器，并在 Nginx 准备对应证书。公网客户端访问 HTTPS `443`。

1. 将当前 [compose.yaml](../compose.yaml) 保存到服务器的部署目录。包含独立 `remote-command-<版本>-compose.yaml` 的 Release 也可直接下载该文件并保存为 `compose.yaml`。如果 GHCR 包为私有，先用具备 `read:packages` 权限的账号执行 `docker login ghcr.io`。
2. 在 `compose.yaml` 直接填写 `PUBLIC_ORIGIN`、`OAUTH_CLIENT_ID`、`OAUTH_REDIRECT_URIS` 和 `volumes.source`。`PUBLIC_ORIGIN` 是 Nginx 对外的 HTTPS 地址，用于生成 OAuth 元数据和设备配对链接。

3. 首次部署时准备数据目录。以下命令以默认目录 `./data` 为例。Gateway 容器以 `1000:1000` 运行，该用户需要对数据目录有读写权限。

```sh
sudo install -d -m 0700 -o 1000 -g 1000 ./data
```

4. 启动 Gateway。Compose 按需拉取镜像。Gateway 在 SQLite 所在目录初始化 `.oauth_client_secret` 和 `.owner_key`，权限为 `0600`。默认宿主机路径是 `data/.oauth_client_secret` 和 `data/.owner_key`。已有密钥文件会在容器重建后继续使用。

```sh
docker compose up -d --wait
```

   若部署时已有同一站点的凭证，可在首次启动前将原值写入对应文件，设置所有者为 `1000:1000`、权限为 `0600`。

5. 将 [Nginx 站点示例](../deploy/nginx/remote-command.conf) 放到宿主机 Nginx 已启用的站点配置目录。修改 `server_name`、`ssl_certificate` 和 `ssl_certificate_key`，使域名与 Compose 的 `PUBLIC_ORIGIN` 一致。站点保留完整 URI，将 `/mcp`、OAuth、Agent 接口和 `/manage` 统一转发到 `127.0.0.1:8787`。示例的 `40m` 请求体上限与 Gateway 同步接口一致。

   以使用 systemd 且包含 `/etc/nginx/conf.d/*.conf` 的服务器为例，放置并编辑配置后执行下面的命令。

```sh
sudo nginx -t && sudo systemctl reload nginx
```

6. 从宿主机检查 `http://127.0.0.1:8787/readyz`，再从客户端检查 `https://mcp.example.com/readyz`。确认 `https://mcp.example.com/.well-known/oauth-protected-resource/mcp` 返回的 `resource` 使用实际 HTTPS 域名。用 `data/.owner_key` 登录 `/manage`，再按 [README 快速开始](../README.md#第二步在目标电脑启动-agent) 安装同版本 Agent 并接入 ChatGPT。

---

## 2. 离线镜像与维护者构建

### 使用离线镜像包

以 `0.5.0` 为例。导入 `linux/amd64` 离线镜像后，将 Compose 的 `image` 改为 `remote-command:0.5.0`。

```sh
docker image load -i remote-command-0.5.0-gateway-linux-amd64.tar.gz
docker compose up -d --pull never --wait
```

### 从源码目录直接构建

维护者可在源码根目录构建镜像。将测试环境 Compose 的 `image` 设为 `remote-command:local` 后启动。

```sh
docker build -t remote-command:local .
docker compose up -d --pull never --wait
```

---

## 3. 升级与回退

1. **备份先行**：升级前执行在线备份并校验备份文件（见第 6 节），同时保留现用镜像、Compose 配置和密钥文件。
2. **更新镜像**：更新 Compose 的 `image`，保留同一个宿主机数据目录与密钥文件，然后执行 `docker compose up -d --wait`。
3. **升级验收**：等待 `/readyz` 返回成功，在 ChatGPT 中对已配对设备执行一次读取、一次需本机确认的操作和一次后台任务，核对结果正常。
4. **回退处理**：需要回退数据时，将升级前的快照恢复到新数据库路径（见第 6 节），并恢复对应镜像和 Compose 配置。

---

## 4. 构建与发布产物

从源码生成完整发布产物需要 **Node.js 24–26**、`npm` 与 `tar`；附加 `--with-image` 时还需本机安装 Docker：

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-0.5.0-SHA256SUMS
```

也可在 GitHub Actions 中手动触发 **CI & Release / 自动化测试与发布** 工作流并勾选发布选项。测试全部通过后，工作流将 Gateway 镜像推送至 GHCR，并在 GitHub Release 上传独立 Compose 文件、Agent 安装包、部署包、离线镜像与 SHA-256 清单。

---

## 5. Agent 安装与后台服务托管

将 Agent 解包到当前用户管理的固定目录并按锁文件安装依赖，即可注册为系统用户级后台服务（开机/登录自启）：

### macOS / Linux

```sh
rcm_client="$HOME/.remote-command/client-0.5.0"
mkdir -p "$rcm_client"
tar -xzf /path/to/remote-command-0.5.0.tgz -C "$rcm_client" --strip-components=1
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

备份文件包含设备配对、工具结果与审计历史，请仅限管理员读写，并在异机保留加密副本。SQLite 快照之外，还需单独备份两个密钥文件、Compose 和 Nginx 配置。

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

2. 在维护窗口给 Compose 的 `gateway.environment` 增加 `STATE_DB: /data/gateway-recovered.sqlite`，然后重启 Gateway。

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
| **数据保留策略** | 已结束任务默认保留 **7 天**，审计日志默认保留 **90 天**。可在 Compose 的 `gateway.environment` 设置 `RCM_TASK_RETENTION_DAYS` 和 `RCM_AUDIT_RETENTION_DAYS`。 |
| **紧急撤销与诊断** | `/manage` 可撤销单台或全部设备，也可单独撤销 ChatGPT 授权。客户端可使用 `remote --report` 导出脱敏诊断包。 |

真实域名生产验收建议覆盖：外网 TLS 证书、真实 ChatGPT 账号接入、一次读操作、一次本机审批操作、一次后台任务查询及一次备份恢复演练。当前已验证环境与待测项见 [验收记录](verification.md)。
