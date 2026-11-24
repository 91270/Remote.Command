# 验收记录

2026-11-18 使用实际 Desktop Commander 0.3.3 发布类做了认证与 stdio 桥接探测，并运行独立客户端的测试。两个探针保留了上游程序逻辑，认证网络响应和遥测等外部依赖使用本机测试数据。[配对探针](client-probe-results.json) · [stdio 桥接探针](client-bridge-probe-results.json)

| 检查 | 结果 |
| --- | --- |
| 官方客户端认证 | 使用实际认证类验证 S256、轮询等待、放慢轮询、临时错误重试、拒绝和成功分支。 |
| 官方客户端 stdio 桥接 | 启动真实 MCP 测试子进程，验证工具发现、参数和元数据转发、图片与结构化结果保留、调用中断、并发重启和主动关闭。 |
| macOS 客户端 | x86_64、Node.js 26.11.0。完整测试 8 项全部通过，包含配置的 Chrome 渲染、HTTPS、终端逐次确认、进程恢复和诊断。另由 `launch.sh` 启动，独立复跑整条 HTTPS 链路通过。 |
| Linux 客户端 | Debian bookworm x86_64 容器、Node.js 24.22.3，安装 ripgrep 和 procps。完整套件 7 项通过，Markdown 转 PDF 渲染因容器未配置 Chrome 跳过。PDF 读取及页删除已运行。 |
| 原生工具与资源 | 在 macOS 对 25 个原生工具完成有效调用，读取两个 MCP App HTML 资源。覆盖交互 REPL、进程结束、会话搜索、文本编辑、Excel、DOCX、图片、显式 URL 读取和 PDF。 |
| 独立 Agent 生命周期 | 浏览器短码配对由真实 CLI 发起，管理 API 完成批准。验证首次启动、持久身份恢复、临时会话退出时撤销、执行器被终止后自动重建、Gateway 重启后结果查询、单独任务取消和健康登出。 |
| 文件和设备边界 | 验证工作区外路径被拒绝，Linux 覆盖不同大小写的同级目录。验证本机能力、配对权限、任务回执和旧启动实例的离线请求。 |
| 便携运行时启动器 | POSIX 语法检查通过。隔离模拟 Node.js 发行文件下载，覆盖 SHA-256 不符时拒绝与校验通过后从私有目录启动。当前实机启动使用的是已有 Node.js。 |
| Docker Compose | 构建并运行 Gateway 0.2.0，容器健康检查通过。Caddy 与 Gateway 在隔离私网启动，使用临时受信 CA 通过真实 TLS 请求健康页、管理页和 OAuth 发现，三者均返回 200。 |
| Windows | 已提供 PowerShell 启动器、路径示例和 CI 验收配置，尚缺 Windows 实机执行结果。 |
| ChatGPT 网页 | 使用实际 MCP SDK 完成 OAuth、Streamable HTTP 初始化和工具调用。真实 ChatGPT 账号安装、生产域名证书及宿主 MCP App 渲染仍待实测。 |

从干净工程目录复跑。

```sh
npm ci --include=dev --ignore-scripts
PRM_TEST_FULL=1 npm test
```

macOS/Linux 可通过实际启动器测试完整 TLS 链路。需要 Python 3 和 OpenSSL。

```sh
PRM_TEST_LAUNCH=1 PRM_TEST_FULL=1 PRM_TEST_TLS=1 PRM_TEST_TTY=1 node --test test/e2e.test.mjs
```

Markdown 转 PDF 通过 `PRM_TEST_CHROME_PATH` 指定本机 Chrome。宿主机 `8787` 空闲时，可在独立源码副本验证本地构建的 Gateway 镜像。显式指定测试数据目录，避免复用生产数据库。

```sh
npm run setup -- mcp.invalid.example
docker build -t remote-command:compose-test .
export RCM_GATEWAY_IMAGE=remote-command:compose-test
export RCM_DATA_DIR="$(mktemp -d)/gateway-data"
docker compose -p rcm-verify config -q
docker compose -p rcm-verify up -d --pull never --wait --wait-timeout 45
docker compose -p rcm-verify port gateway 8787
curl --fail http://127.0.0.1:8787/readyz
docker compose -p rcm-verify down
```

数据目录初始化与容器重建后的持久化，以及 Nginx HTTPS、OAuth 资源发现和同步请求体检查位于 GitHub Actions 的 `compose` 作业。生产环境验收步骤见[运维指南](production.md#1-首次部署)。

Windows、生产域名和 ChatGPT 账号的验收步骤见[部署与启动说明](../README.md)。官方生产账户、计费、遥测及宿主审核流程与独立客户端的范围对照见[架构说明](architecture.md)。

## npm 客户端 0.2.1

| 检查 | 结果 |
| --- | --- |
| 打包与独立安装 | `npm run package:client` 生成约 895 KiB 的 `.tgz`。归档包含编译后的客户端、依赖锁和两份上游 MIT 许可证。检查归档未发现本机配置、私有状态或缓存。macOS 从工程之外安装并运行 `npx`。 |
| macOS 已安装客户端 | Node.js 26.11.0，8 项通过。通过安装后的 `bin` 入口完成 OAuth、真实 TLS、浏览器短码配对、工具调用、设备端审批、断线恢复、临时会话、诊断和注销。另用真实终端输入验证首次运行配置、默认只读和私有文件权限。 |
| Linux 已安装客户端 | Debian bookworm x86_64 容器、Node.js 24.22.3。独立安装后 `remote --help` 可运行，随包平台版 ripgrep 可执行。 |
| 管理页 | 在实际 Chrome 中打开配对弹窗，验证复制动作传入的命令和一次性令牌切换。 |

## Remote Command MCP 0.3.0

| 检查 | 结果 |
| --- | --- |
| 新包名与升级 | 从工程外安装并运行 `npx`。已验证新客户端能读取旧默认路径中的配置，已有设备和任务结果通过数据库升级测试。 |
| HTTPS 端到端 | 从新安装包启动 Agent，9 项通过。新增审阅资源和参数回显校验，预览未入队。跨设备后台记录可查询并支持设备过滤。配对码必须有效且待处理才可核对设备名称。 |
| Chrome 控制台 | 验证登录、桌面与手机布局、设备搜索、最近调用、配对核对与授权、任务结果、审计搜索和接入地址。 |
| 审阅界面 | 在 Chrome 的模拟 MCP Apps 宿主中验证点击后发送一次普通 `tools/call`，并验证被拦截的预览没有发送调用。真实 ChatGPT 网页宿主和 Windows 实机待验收。 |
| Docker Gateway | 在 Linux 容器验证镜像启动、健康检查、新控制台、OAuth 发现和审阅资源打包。本机外置盘的直接构建遇到 BuildKit 读取 macOS 扩展属性报错，使用下方归档上下文构建通过。 |

在 macOS 或 Linux 上复跑当前安装包的端到端测试，需要 Python 3、OpenSSL 和用于渲染 PDF 的 Chrome 或 Chromium。

```sh
npm run package:client
prm_install=$(mktemp -d)
npm install --prefix "$prm_install" --ignore-scripts "$PWD/releases/remote-command-mcp-0.3.0.tgz"
PRM_TEST_FULL=1 PRM_TEST_TLS=1 PRM_TEST_TTY=1 \
  PRM_TEST_PACKED_CLI="$prm_install/node_modules/.bin/remote-command-mcp" npm test
```

如 macOS 外置盘上的 Docker 构建报 `failed to xattr`，可在工程根目录将构建上下文打包后传给 Docker。使用 Compose 默认项目名时，镜像命令如下。完成 `.env` 配置后可以用 `docker compose up -d --no-build` 启动。

```sh
tar --no-xattrs --no-mac-metadata --exclude='._*' -cf - \
  Dockerfile .dockerignore .npmrc tsconfig.json src web \
  deploy/gateway/package.json deploy/gateway/package-lock.json \
  vendor/desktop-commander-full/catalog.json \
  | docker build -t private-remote-mcp-gateway -
```

## Remote Command MCP 0.4.0

| 检查 | 结果 |
| --- | --- |
| 发布产物 | 已生成 npm 客户端、独立部署包、Linux amd64 Gateway 镜像及 SHA-256 清单。使用清单校验三项产物通过。 |
| 独立客户端与 HTTPS | 使用在临时目录安装的 0.4.0 npm 客户端，macOS 本地 HTTPS、OAuth、MCP 联调及相关测试共 11 项通过。源码在全新临时目录按锁文件安装后编译通过。直接 `npm install <tgz>` 的间接依赖在本次测得与包内锁文件不同。另实测解包后执行 `npm ci --omit=dev --ignore-scripts`，间接依赖匹配包内锁文件，CLI 可启动。 |
| 独立 Compose 部署 | 从解包目录导入交付镜像并启动隔离 Gateway。`/readyz`、管理页和 OAuth 发现接口通过。镜像无须在外置盘直接构建。 |
| 在线备份及恢复 | 对运行中的套件从宿主生成备份，在容器中校验，再通过独立的一次性容器恢复到另一个数据库路径。原 Gateway 在演练期间继续使用原库。带设备、未完成任务和结果的单元测试验证原库不被覆盖、恢复不重放任务、已完成结果保留。 |
| 后台服务配置 | 已覆盖三平台定义生成与路径转义，并使用 macOS `plutil` 验证 LaunchAgent 配置。Linux、Windows 原生服务管理器的启停周期仍待实机验证。 |
| 生产环境 | 真实域名、正式 ChatGPT 账号和 Windows 部署尚待验收。Git 已初始化于 `main`，CI 工作流已经写入工作区，尚无远程运行记录。 |

部署、备份、恢复和服务命令见 [生产运维](production.md)。上游执行路径与自建差异见 [官方架构核对](official-architecture.md)。

## Remote Command MCP 0.4.1

| 检查 | 结果 |
| --- | --- |
| 独立客户端与 HTTPS | 在 macOS 临时目录解包，用 `npm ci --offline --omit=dev --ignore-scripts` 安装锁定依赖，再使用包内 CLI 执行完整测试。11 项通过，覆盖 OAuth、Streamable HTTP、本地 MCP、终端审批、断线、取消及批量撤销后 Agent 退出。 |
| 设备管理 | 批量撤销要求已登录管理员和 CSRF 校验。测试覆盖同时撤销在线和离线设备、令未用配对失效、中断未完成任务、保留已完成结果和审计，并确认管理员和 OAuth 会话继续有效。 |
| 控制台 | 在 Chrome 的 390 px 窄屏视口实测批量撤销。取消后凭证继续有效，确认后凭证失效，并显示撤销数量。 |
| 独立 Compose 部署 | 三份发布产物通过 SHA-256 校验。由部署包解出的 Compose 配置成功启动导入的 Linux amd64 镜像，并验证 `/readyz`、控制台和 OAuth 资源发现。 |
| 最后连接时间 | 升级时从旧库现存的有效时间回填。离线、撤销和备份恢复后仍可查询。旧版本已清空的时间无法恢复。 |
| 只读调用延迟 | 本机回环 HTTP，同一个 0.4.1 Gateway，分别运行 0.4.0 和 0.4.1 Agent。预热一次后，各串行读取同一份小文件 12 次。`read_file` 的 p50 从 1,609 ms 降至 810 ms，p95 从 1,816 ms 降至 1,010 ms。结果只用于比较本机回传等待。 |
| 外部环境 | 真实 ChatGPT 网页账户、公开域名和 Windows 实机待验收。 |
