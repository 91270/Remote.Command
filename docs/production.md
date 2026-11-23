# Remote.Command 生产运维指南

本文档面向单管理员生产环境部署，涵盖 **Gateway 首次部署、离线镜像导入、版本升级与回退、Agent 后台服务托管、在线备份恢复与日常巡检**。

> [!NOTE]
> Gateway 运行在公网 Linux 服务器上，设备配对记录、任务队列与审计日志保存在 Docker 卷 `gateway-data` 中，HTTPS 证书由 Caddy 自动签发与续期。

---

## 1. 首次部署

**前置条件**：公网 Linux 服务器（已安装 Docker Compose 与 Node.js 24–26）、域名已解析至服务器、防火墙开放 **TCP 80 / 443**（Gateway 的 `8787` 端口仅在 Compose 内网暴露）。

1. 从 [v0.4.1 Release](https://github.com/91270/Remote.Command/releases/tag/v0.4.1) 下载部署包 `remote-command-0.4.1-deploy.tar.gz` 与校验清单 `remote-command-0.4.1-SHA256SUMS` 至同一目录并校验解压：

```sh
sha256sum --ignore-missing -c remote-command-0.4.1-SHA256SUMS
tar -xzf remote-command-0.4.1-deploy.tar.gz
cd remote-command-0.4.1
```

2. 生成 `.env` 配置（将 `mcp.example.com` 替换为你的域名；若 ChatGPT 已给出专用回调 URI，可作为第二个参数传入；已有 `.env` 可直接沿用）：

```sh
npm run setup -- mcp.example.com
```

3. 指定 GHCR 镜像并启动服务（若镜像为私有，请先 `docker login ghcr.io`）：

```sh
printf '%s\n' 'RCM_GATEWAY_IMAGE=ghcr.io/91270/remote.command:0.4.1' >> .env
docker compose up -d --no-build --pull always --wait
```

4. 验证服务状态：
   - 访问 `https://mcp.example.com/readyz` 确认返回 `200`。
   - 访问 `https://mcp.example.com/manage`，使用 `.env` 中的 `OWNER_KEY` 登录控制台。
   - 随后参考 [README 快速开始](../README.md#第二步在目标电脑启动-agent) 安装本地 Agent 并接入 ChatGPT。

---

## 2. 离线镜像与源码构建

### 使用离线镜像包

同一个 Release 中提供了 `linux/amd64` 离线镜像包。校验并导入镜像后，将 `.env` 中的 `RCM_GATEWAY_IMAGE` 改为 `remote-command:0.4.1`（Compose 会另外拉取 `caddy:2-alpine` 镜像）：

```sh
docker image load -i ../remote-command-0.4.1-gateway-linux-amd64.tar.gz
docker compose up -d --no-build --wait
```

### 从源码目录直接构建

```sh
docker compose up --build -d --wait
```

---

## 3. 升级与回退

1. **备份先行**：升级前先执行在线备份并校验备份文件（见第 6 节），同时保留旧版本镜像、部署文件与 `.env` 副本。
2. **原地更新**：在原部署目录更新部署文件或修改 `.env` 中的 `RCM_GATEWAY_IMAGE` 版本号，沿用同一 Compose 项目与 `gateway-data` 数据卷。Gateway 启动时会自动执行数据库迁移。
3. **升级验收**：等待 `/readyz` 返回成功，在 ChatGPT 中对已配对设备执行一次读取、一次需本机确认的操作和一次后台任务，核对结果正常。
4. **回退处理**：若旧版本镜像不兼容新版数据库结构，请将升级前的备份快照恢复到一个新数据库路径（见第 6 节），再切回旧镜像启动。

---

## 4. 构建与发布产物

从源码生成完整发布产物需要 **Node.js 24–26**、`npm` 与 `tar`；附加 `--with-image` 时还需本机安装 Docker：

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-0.4.1-SHA256SUMS
```

也可在 GitHub Actions 中手动触发 **Verify** 工作流并勾选发布选项：测试全部通过后，工作流会自动将 Gateway 镜像推送至 GHCR，并发布同版本的 Agent 安装包、部署包、离线镜像与 SHA-256 清单。

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

备份文件包含设备配对记录、工具结果与审计历史，**请仅限管理员读写，并在异机保留加密副本**（`.env` 与自定义 `Caddyfile` 需单独备份）。

### 在线备份与校验

运行中的 Gateway 支持直接在线导出一致的 SQLite 快照：

```sh
npm run backup -- /private/backups/rcm-2026-11-19.sqlite
docker compose exec -T gateway node dist/admin.js verify-backup < /private/backups/rcm-2026-11-19.sqlite
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
docker compose up -d --no-deps --no-build --wait gateway
```

> [!IMPORTANT]
> 恢复操作会保留已完成调用的结果与审计记录，但会**清除 OAuth 会话、管理页会话和待用邀请**，将所有设备标为已撤销、进行中的任务标为已中断。恢复完成后请重新配对设备并授权 ChatGPT，同时检查原设备是否有旧进程仍在运行。

---

## 7. 日常巡检清单

| 检查项 | 验证方式与说明 |
| --- | --- |
| **服务健康** | `/healthz`（存活）与 `/readyz`（数据库可访问）均返回 `200`。 |
| **HTTPS 与 OAuth** | 确认 TLS 证书有效，且 `/.well-known/oauth-protected-resource/mcp` 中的资源 URI 指向你的 HTTPS Gateway。 |
| **日志与磁盘** | 执行 `docker compose logs --tail 100 gateway caddy`，定期检查宿主机磁盘与备份空间。 |
| **数据保留策略** | 已结束任务默认保留 **7 天**，审计日志默认保留 **90 天**，可通过 `RCM_TASK_RETENTION_DAYS` 与 `RCM_AUDIT_RETENTION_DAYS` 调整（累计调用统计跨清理保留）。 |
| **紧急撤销与诊断** | 在 `/manage` 控制台可撤销单台/全部设备或单独撤销 ChatGPT 授权（批量撤销会作废现有配对码与邀请）；客户端排查可使用 `remote --report --no-upload` 导出脱敏诊断包。 |

真实域名生产验收建议覆盖：外网 TLS 证书、真实 ChatGPT 账号接入、一次读操作、一次本机审批操作、一次后台任务查询及一次备份恢复演练。当前已验证环境与待测项见 [验收记录](verification.md)。
