# Remote.Command

Remote.Command 让 ChatGPT 访问你自己的电脑。Gateway 部署在你的服务器上，Agent 在目标电脑上运行，并主动通过 HTTPS 连接 Gateway。Agent 支持 Windows、macOS 和 Linux，设备无需开放公网端口。

文件和终端工具复用 Desktop Commander 0.3.3 发布包中的 MIT 核心。配对、认证和任务由自建 Gateway 管理。服务限制并发、响应大小和执行时间，调用按次累计不设上限。

## 部署 Gateway

准备一台装有 Docker Compose 和 Node.js 24–26 的 Linux 服务器。把域名指向服务器，开放 TCP 80 和 443，供 Caddy 签发 HTTPS 证书。

从 [GitHub Release](https://github.com/91270/Remote.Command/releases/tag/v0.4.1) 下载部署包，在服务器上解压。进入解压后的目录，把示例域名换成自己的域名，再运行以下命令。镜像为私有时，先以有读取权限的凭证登录 `ghcr.io`。[离线部署与升级](docs/production.md)

```sh
npm run setup -- mcp.example.com
printf '%s\n' 'RCM_GATEWAY_IMAGE=ghcr.io/91270/remote.command:0.4.1' >> .env
docker compose up -d --no-build --pull always --wait
```

打开 `https://mcp.example.com/manage`，用 `.env` 中的 `OWNER_KEY` 登录。Gateway 使用 `gateway-data` 卷保存设备配对和任务记录。日常重启和升级请保留该卷及 `.env`。

## 安装 Agent

在要连接的设备上安装 Node.js 24–26，然后运行下面这条命令。Agent 会从 GitHub 下载，再在本机启动。

```sh
npx --yes --ignore-scripts --package=https://github.com/91270/Remote.Command/releases/download/v0.4.1/remote-command-0.4.1.tgz remote-command remote
```

1. 输入 Gateway 的 HTTPS 地址，选择允许 Agent 访问的工作区。直接回车会选当前目录和只读权限。
2. 在浏览器打开的管理页核对设备名和配对码，再批准配对。无桌面环境可用 `--no-browser`，把终端显示的网址复制到另一台设备打开。
3. 配对后，在管理页确认设备在线。下次运行同一条命令会使用保存的身份。

新设备的配置写入 `~/.remote-command/agent.json`。若已有 `~/.remote-command-mcp/agent.json` 或 `~/.private-remote-mcp/agent.json`，Agent 会继续读取旧配置。需要单独指定配置时，用 `remote --config PATH`。

## 接入 ChatGPT

1. 在支持自定义 MCP 的 ChatGPT 账号或工作区添加 `https://mcp.example.com/mcp`，认证选择 OAuth，填写 `.env` 中的 `OAUTH_CLIENT_ID` 和 `OAUTH_CLIENT_SECRET`。[OpenAI 自定义 MCP 指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)
2. 如果 ChatGPT 显示的回调地址与 `.env` 不同，将完整地址填入 `OAUTH_REDIRECT_URIS`，再运行 `docker compose up -d --force-recreate gateway`。打开授权页时，在你自己的 Gateway 域名下输入 `OWNER_KEY`。
3. 在对话里让 ChatGPT 列出设备。通过 `select_device` 选择目标，也可在工具调用中传入 `deviceId`（兼容 `device_id`）。只有一台设备在线时，Gateway 可以自动选中它。

## Agent 安装选项

也可以先下载 `remote-command-0.4.1.tgz`，再用本地文件启动。源码目录运行 `npm run package:client` 也会生成同样格式的包。

```sh
npx --yes --ignore-scripts --package=/path/to/remote-command-0.4.1.tgz remote-command remote
```

启动参数放在 `remote` 后面。

| 参数 | 用途 |
| --- | --- |
| `--help` | 查看用法 |
| `--logout` | 撤销设备配对并清除本机凭证 |
| `--report --no-upload` | 生成本地诊断 ZIP |
| `--no-persist-session` | 创建临时会话，正常退出时撤销临时设备 |
| `--disable-no-sleep` | 停用 macOS 的保持唤醒模式 |
| `--debug` | 显示本地执行器恢复细节 |
| `--no-browser` | 显示配对网址，适用于无桌面设备 |

当前发布方式是 GitHub 上的 `.tgz`。Agent 会按设备平台选用 npm 包提供的 ripgrep。最小化 Debian 环境需要 `procps`。Markdown 转 PDF 需要本机 Chrome 或 Chromium。

## 用源码启动或手动配置客户端

在设备上复制工程。若需预先指定路径、权限或命令配置，将 `agent.example.json` 复制为 `agent.local.json` 并填好实际值。

| 字段 | 用途 |
| --- | --- |
| `gateway` | 自建 Gateway 的 HTTPS origin |
| `workspace` | 设备允许访问的项目目录，使用绝对路径 |
| `stateDir` | 该 Agent 的私有状态目录，放在工作区外。Unix 已有目录权限须为 0700 |
| `desktopCommander` | 默认 `true`，启用完整的 25 工具核心 |
| `capabilities` | 本机允许的 `read`、`write`、`exec`，默认只读 |
| `ripgrep` | 可选的本地 `rg` 路径。省略时优先使用 npm 包提供的二进制，再查找 `PATH` |
| `chromePath` | 可选的 Chrome/Chromium 路径，Markdown 转 PDF 时使用。省略时尝试使用系统中已有的浏览器 |
| `noSleep` | 默认 `true`，macOS 上运行期间使用 caffeinate 保持唤醒 |
| `profiles` | 额外的 `remote_start_command` 工具使用的程序映射，原生 `start_process` 使用正常的 shell 命令接口 |

Windows JSON 路径可用 `C:/Users/you/workspace`。PowerShell 的 `(Get-Command node).Source` 和 `(Get-Command rg).Source` 可查程序路径。Unix 可用 `command -v`。工作区、安装目录、Agent 配置与私有状态各自使用独立路径。

像官方客户端一样，在终端运行对应系统的启动器。

```sh
./launch.sh agent.local.json
```

Windows PowerShell 使用以下命令。

```powershell
.\launch.ps1 agent.local.json
```

启动器优先使用设备上的 Node.js 24–26。缺少兼容版本时，终端会询问是否下载适合本机的 Node.js 24 便携版，按官方 SHA-256 清单校验后放在工程的私有运行目录。随后根据锁文件准备依赖、编译并启动 Agent。[Node.js 24 官方发行目录](https://nodejs.org/dist/latest-v24.x/)

已有 Node.js 时也可手动运行。

```sh
npm ci --include=dev --ignore-scripts
npm run build
node dist/agent.js connect agent.local.json
```

首次连接会显示配对码并打开自建 Gateway 的管理页。核对设备和权限后点击授权，Agent 随即启动。以后同一条命令会使用已保存的设备身份。无桌面环境可加 `--no-browser`，从另一台设备打开终端显示的网址。只配对可以用 `login`，只启动已配对设备可以用 `run`。

`connect` 支持 `--no-persist-session`。它为本次运行配对单独的设备，只在内存里保存凭证，正常退出时撤销临时设备。如果断网或被强制终止，管理页仍可撤销该设备。macOS 可加 `--disable-no-sleep`，排查执行器恢复时可加 `--debug`。

也可在管理页生成十分钟有效的一次性邀请，在本机执行 `node dist/agent.js pair agent.local.json` 粘贴邀请。服务器 CLI 的等价命令为 `docker compose exec gateway node dist/admin.js pair laptop read,write,exec`。

一个身份只运行一个 Agent 实例。身份保存在私有状态下，重启可直接 `run`。客户端主动重连，设备端无需开放端口。本地 MCP 子进程故障后会自动恢复。恢复期间显示离线，Gateway 暂停派发任务。

## 工具

| 能力 | 原生工具 |
| --- | --- |
| 文本、图片、URL、Excel、PDF、DOCX 读取 | `read_file`、`read_multiple_files`、`get_file_info` |
| 写入、追加、目录和改名 | `write_file`、`create_directory`、`list_directory`、`move_file` |
| 代码块替换、Excel 单元格/范围和文档编辑 | `edit_block` |
| PDF 创建、修改和组合 | `write_pdf` |
| 交互终端、REPL、后台会话和输出分页 | `start_process`、`interact_with_process`、`read_process_output`、`list_sessions` |
| 进程列表和终止 | `list_processes`、`kill_process`、`force_terminate` |
| 搜索会话和分页 | `start_search`、`get_more_search_results`、`stop_search`、`list_searches` |
| 配置、统计和本地调用历史 | `get_config`、`set_config_value`、`get_usage_stats`、`get_recent_tool_calls` |
| 本地反馈记录 | `give_feedback_to_desktop_commander` |

文件预览与配置编辑通过核心的两个 MCP App 资源提供，是否显示取决于 MCP 客户端的资源支持。Gateway 保留原生的 `content`、图片数据、`structuredContent` 和 `_meta`。结果体积上限为 4 MiB，可用原生分页参数缩小响应。

用 `list_devices` 和 `select_device` 找到目标设备，用 `who_am_i` 查看当前身份及用量。`list_remote_tool_calls` 可以按设备筛选后台记录，默认显示所有设备的调用。`get_tool_result` 查询结果，`review_device_call` 预览调用，`shutdown` 断开 Agent。旧的 `remote_*` 工具继续接受相对工作区路径。

原生文件工具遵循本机配置的 `allowedDirectories`。这项配置可以在工作区内缩小范围，扩大范围须在本地修改 Agent 的工作区。工具支持的具体参数保留上游 schema，包括负数 offset、append、searchType、sheet/range、PDF 操作和终端超时。

## 确认与后台任务

写文件和修改配置需要在设备端确认，启动命令、终止进程或断开 Agent 也一样。在设备终端查看调用参数，再将返回的 `call_id` 填入 `rcm_call_id`。

```sh
rcm_call_id=PASTE_CALL_ID_HERE
node dist/agent.js approvals agent.local.json
node dist/agent.js decide agent.local.json "$rcm_call_id" approve
```

也可用 `deny` 拒绝。CLI 展示完整参数，须输入对应决定。批准与该次请求绑定，五分钟过期。配对授权只确定能力范围，每次敏感调用仍需确认。

使用 npm 客户端包时，以下命令进入同一个本机确认流程。已有配对用户请传入自己的原配置路径。

```sh
npx --yes --ignore-scripts --package=/path/to/remote-command-0.4.1.tgz remote-command agent approvals ~/.remote-command/agent.json
npx --yes --ignore-scripts --package=/path/to/remote-command-0.4.1.tgz remote-command agent decide ~/.remote-command/agent.json "$rcm_call_id" approve
```

短调用直接返回原生结果，后台调用用 `get_tool_result(call_id)` 查询，避免重复执行。原生 `start_process` 返回的 PID 指向持续运行的终端会话，用 `read_process_output` 和 `force_terminate` 管理。取消一次 MCP 请求与终止已经启动的进程各有自己的接口。

用户可以要求用 `review_device_call` 预览尚未执行的工具和原始参数。支持 MCP Apps 且提供工具桥接的宿主可让用户通过普通 MCP 调用运行一次或取消。已被宿主拦截的调用仅供查看，执行权限仍由宿主和设备控制。

Gateway 重启后仍可取回同一 Agent 进程内运行的结果。Agent 重启后，未确认结束的已派发任务标为 `interrupted`，重试前检查设备。每设备最多四个已派发任务、64 个排队任务，排队项 15 分钟过期，结果保留七天。

已批准的 shell 以 Agent 所属用户权限运行。终端命令的权限由该 OS 用户决定。文件路径检查与操作之间存在并发修改窗口，工作区应由可信本地用户管理。

## 客户端维护

```sh
node dist/agent.js status agent.local.json
node dist/agent.js report agent.local.json
node dist/agent.js logout agent.local.json
node dist/agent.js --help
```

`report` 生成本地诊断 ZIP，包含环境检查和最近的连接、执行器恢复事件。它也能在工作区或可选程序缺失时报告原因，诊断文件不包含命令、工具参数、文件内容或认证凭证。`logout` 先向 Gateway 撤销设备，再删除本地身份。网络失败时保留凭证供重试。`shutdown` 用于断开远程 Agent，重新连接需在本机启动。

管理页可以分别撤销单台设备、全部设备或全部 OAuth 授权。批量撤销设备会作废现有配对码和邀请，并将未完成任务标为中断。设备离线后仍会显示最后成功同步时间。服务器 CLI 支持 `node dist/admin.js devices`、`revoke <DEVICE_ID>`、`oauth-revoke` 和 `audit`。

## 验证与客户端分析

```sh
npm test
PRM_TEST_FULL=1 PRM_TEST_TLS=1 PRM_TEST_TTY=1 npm test
```

第二条在 macOS/Linux 上增加完整 Agent、真实 TLS 和终端审批验收，需要 OpenSSL 与 Python 3。PDF 创建测试使用本地 Chrome，可指定 `PRM_TEST_CHROME_PATH`。

官方客户端的配对和工具转发过程见 [客户端分析](docs/client-analysis.md)。传输实现及自建方案的差异见 [官方架构核对](docs/official-architecture.md)。测试环境和验收结果见 [验证记录](docs/verification.md)。

复用的核心位于 `vendor/desktop-commander-full`，目录内保留 [MIT 许可证](vendor/desktop-commander-full/LICENSE) 和 [本地修改说明](vendor/desktop-commander-full/NOTICE.md)。
