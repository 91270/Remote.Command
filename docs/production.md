# Remote.Command 运维

Gateway 在一台公网 Linux 服务器上运行。设备、任务和审计记录保存在 Docker 的 `gateway-data` 卷里，Caddy 负责 HTTPS。本文以单管理员部署为例。

## 首次部署

服务器需要 Docker Compose 和 Node.js 24–26。先把域名指向服务器，再开放 TCP 80 和 443。Gateway 的 8787 只在 Compose 私网中使用。

从 [0.4.1 Release](https://github.com/91270/Remote.Command/releases/tag/v0.4.1) 下载部署包和 SHA-256 清单。把两份文件放在同一目录，校验通过后解包。域名换成你自己的。

```sh
sha256sum --ignore-missing -c remote-command-0.4.1-SHA256SUMS
tar -xzf remote-command-0.4.1-deploy.tar.gz
cd remote-command-0.4.1
npm run setup -- mcp.example.com
```

如果 ChatGPT 已经给出专用回调 URI，可把它作为域名后面的第二个参数。已有 `.env` 的部署直接沿用原文件。

用 GHCR 镜像时，把下面一行加到 `.env`。私有镜像需要先登录 `ghcr.io`。

```dotenv
RCM_GATEWAY_IMAGE=ghcr.io/91270/remote.command:0.4.1
```

```sh
docker compose up -d --no-build --pull always --wait
```

浏览器打开自己域名下的 `/readyz` 确认服务可用，再访问 `/manage`，用 `.env` 里的 `OWNER_KEY` 登录。随后按 README 安装 Agent 并接入 ChatGPT。[快速开始](../README.md)

## 从离线镜像或源码启动

离线镜像包也在同一个 Release。按服务器架构选择并校验镜像包，导入后把 `.env` 中的镜像改为 `RCM_GATEWAY_IMAGE=remote-command:0.4.1`。仓库当前提供 Linux amd64 镜像，Compose 会另外取得 Caddy 镜像。

```sh
docker image load -i ../remote-command-0.4.1-gateway-linux-amd64.tar.gz
docker compose up -d --no-build --wait
```

也可直接用部署包内的 Dockerfile 构建。在同一目录运行 `docker compose up --build -d --wait`。

## 升级与回退

1. 先备份数据库并校验备份。保留旧镜像、部署文件和受保护的 `.env` 副本。
2. 在原部署目录更新文件或镜像版本，沿用同一 Compose 项目和数据卷。数据库迁移在 Gateway 启动时执行。
3. 等 `/readyz` 返回成功，再用 ChatGPT 读取已配对设备上的文件。再跑一次需要本机批准的操作和一项后台调用，核对结果。
4. 如果回退的镜像需要旧版数据库，把升级前的快照恢复到一个新路径，再指向新路径启动。

## 构建与发布

源码打包需要 Node.js 24–26、npm 和 tar。加 `--with-image` 时还需要 Docker。

```sh
npm run package:release -- --with-image
cd releases
shasum -a 256 -c remote-command-0.4.1-SHA256SUMS
```

在 GitHub Actions 手动运行 **Verify** 并选中发布选项。测试通过后，工作流把 Gateway 镜像推到 GHCR，再发布同版本的 Agent 安装包、部署包、离线镜像和校验清单。

## Agent 安装与后台运行

把 Agent 解包到当前用户管理的固定目录，再用 `npm ci` 按包内锁文件安装依赖。以下命令适用于 macOS 和 Linux。首次配对成功后，按 Ctrl+C 退出前台进程，再安装后台服务。已配对的设备应在最后一条命令里填写原配置路径。

```sh
rcm_client="$HOME/.remote-command/client-0.4.1"
mkdir -p "$rcm_client"
tar -xzf /path/to/remote-command-0.4.1.tgz -C "$rcm_client" --strip-components=1
(cd "$rcm_client" && npm ci --omit=dev --ignore-scripts)
node "$rcm_client/dist/remote-cli.js" remote
node "$rcm_client/dist/remote-cli.js" service install "$HOME/.remote-command/agent.json"
```

Windows PowerShell 可在固定目录中用 `tar.exe` 解包并执行相同的 `npm ci`，再用 `node` 调用解包后的 `dist\remote-cli.js`。服务的身份、日志和审批都属于设备当前用户。macOS 使用 LaunchAgent，Linux 使用 systemd 用户服务，Windows 使用当前用户登录触发的 Task Scheduler 项。首次配对仍在交互终端完成。Linux 需要可运行的 systemd 用户会话，Windows 需要桌面版 PowerShell 和可写入当前用户任务的权限。

服务支持 `render`、`status`、`start`、`stop` 和 `remove`。这些命令都要传入安装时用的配置路径。升级时，把新包解到另一个目录并安装依赖，再移除旧服务，使用原配置安装新服务。旧目录可留作回退。后台服务遵循系统睡眠设置，重新登录时按服务配置启动。退出配对或撤销设备会停止后台 Agent。

敏感调用按原方式在设备终端逐次确认。后台服务命令只负责运行 Agent，设备权限仍来自配对权限和本机配置。

## 备份与恢复演练

备份包含设备配对记录、工具结果和历史数据。备份目录只给管理员读写，另在异机保存一份加密副本。`.env` 和自定义 Caddy 配置单独保存。运行中的 Gateway 可以在线备份。

```sh
npm run backup -- /private/backups/rcm-2026-11-19.sqlite
docker compose exec -T gateway node dist/admin.js verify-backup < /private/backups/rcm-2026-11-19.sqlite
```

恢复时导入新数据库路径，原数据库保留用于核对和回退。恢复被中断时可以用同一快照重试。目标文件已存在时会拒绝恢复。

```sh
docker compose run --rm --no-deps -T -e STATE_DB=/data/gateway-recovered.sqlite gateway \
  node dist/admin.js restore < /private/backups/rcm-2026-11-19.sqlite
```

在维护窗口将 `.env` 中的 `STATE_DB` 改为 `/data/gateway-recovered.sqlite`，执行 `docker compose up -d --no-deps --no-build --wait gateway`。已完成调用的结果和审计记录会保留。恢复过程中会清除 OAuth、管理页会话和待用邀请，将设备标为已撤销，将进行中的任务标为已中断。重新配对设备并授权 ChatGPT，再检查原设备上是否有进程仍在运行。

## 日常检查

| 检查 | 验证方式 |
| --- | --- |
| Gateway 存活和可服务 | `/healthz` 和 `/readyz` 分别返回 200。Compose 使用后者检查数据库可访问性。 |
| HTTPS 和 OAuth | 确认证书有效，`/.well-known/oauth-protected-resource/mcp` 中的资源 URI 指向自己的 HTTPS Gateway。 |
| 容器日志和磁盘 | 使用 `docker compose logs --tail 100 gateway caddy`，检查宿主磁盘和备份空间。 |
| 数据保留 | 已结束任务默认保留 7 天，审计默认保留 90 天。通过 `RCM_TASK_RETENTION_DAYS`、`RCM_AUDIT_RETENTION_DAYS` 配置。累计调用统计跨清理保留。 |
| 撤销和排查 | 在控制台撤销单台或全部设备，也可单独撤销 ChatGPT 授权。批量撤销会作废现有设备配对码和邀请。设备诊断用 `remote --report --no-upload`。 |

真实域名验收要包含外网 TLS、真实 ChatGPT 账户的自定义 MCP 安装、一个读操作、一项需设备端确认的操作、后台任务结果和恢复演练。Windows 需在目标设备执行配对、后台服务启停和升级验收。当前可复现实验及尚未实测的环境见 [验收记录](verification.md)。
