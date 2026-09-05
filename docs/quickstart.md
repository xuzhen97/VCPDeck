# VCPDeck 快速开始：构建 → 部署 → Server/Client 通讯

> 状态：Current｜维护责任：发布/运维维护者｜最后核验：2026-09-05｜适用版本：`0.6.25` / 当前 `main`

本文是从零到"Server 与 Client 双向通讯"的最小可验证路径，所有命令均经过 Windows（Git Bash）端到端演练。完整边界、配置表和升级细节见 [`deployment.md`](./deployment.md)；构件打包决策见 [`ADR-0012`](./adr/0012-bundled-release-artifacts.md)；更新协议见 [`design/release-and-update.md`](./design/release-and-update.md)。

> 命令平台约定：本文命令默认在 **Linux Bash / Windows Git Bash** 下执行；Windows PowerShell 变体在对应小节标注（`curl.exe`、换行符 `` ` `` 等）。

## 1. 前置条件

- 构建机：Node.js 24+、pnpm 11+、可访问 GitHub（frp 下载）；
- 控制面主机与目标机：Node.js 24+（Launcher 可自动选择/下载满足 `>=24` 的 Node）；
- 目标机无需入站端口（Client 主动连接 Server）；
- Linux 目标机需要 `unzip` 命令（解压 zip 与自动更新均依赖）。

## 2. 构建发布包

```bash
pnpm install
pnpm release --version=0.1.1
```

产出 `dist-release/` 下两个按平台分开的包（业务代码为 esbuild 单文件，node_modules 仅含原生/引擎/SDK 最小外部依赖）：

| 文件 | 用途 |
| --- | --- |
| `vcpdeck-0.1.1-win-x64.zip` | Windows 控制面主机与目标机 |
| `vcpdeck-0.1.1-linux-x64.zip` | Linux 控制面主机与目标机 |

每个包同时含 `launcher/`、`server/` 与 `client/` 三套构件；Launcher 首次安装到 `<app-dir>/dist/main.js`，已有 Launcher 默认保留；server 构件另含 `public/`（Frontend 构建产物，由 Server 同源托管，见 §9）。安装/卸载脚本 `install.cjs` / `uninstall.cjs` 与 zip **平级**提供于 `dist-release/` 目录（见 3.1/3.2 节）。构建脚本会打印各包 sha256 与上传命令。

## 3. 部署布局（Launcher apps 结构）

Launcher 以 `apps/<version>/` 保存版本目录，用 current 指针（Linux symlink / Windows state 文件）选择当前版本：

```text
<VCPDECK_APP_DIR>/            # Server 默认 ~/.vcpdeck/launcher；Client 默认 ~/.vcpdeck/launcher-client
# 同机运行时使用两个独立目录：Server=~/.vcpdeck/launcher，Client=~/.vcpdeck/launcher-client
├── control.json              # Launcher 启动后自动生成（控制通道端口与 Token）
├── dist/main.js              # 稳定 Launcher（首次安装由发布 zip 提供）
├── node/                     # Launcher 管理的 Node 运行时缓存
└── apps/
    ├── current -> 0.1.1      # Linux：symlink
    ├── state.json            # Windows：{"current":"0.1.1"}
    └── 0.1.1/
        ├── manifest.json
        ├── server/           # Server 构件（控制面主机保留）
        └── client/           # Client 构件（目标机保留）
```

**持久数据（数据库、Release 目录、Storage）必须放在版本目录之外**，否则 Launcher 切换版本会丢数据。

### 3.1 快速安装脚本（`install.cjs`）——推荐

把发布 zip 安装为版本目录并设置 current 指针、初始化数据库，一条命令完成。支持本地文件或 http(s) URL 下载。

> 安装/卸载脚本与发布 zip **平级提供**于 `dist-release/` 目录（纯 Node 标准库、无仓库依赖）：拿到发布产物即同时拥有脚本与包，无需先解压 zip 拿脚本，也不会对同一个包解压两遍。

```bash
# 发布机（dist-release 目录内，脚本与 zip 同目录）：安装 Server 并引导参数
node install.cjs --artifact=server --zip=vcpdeck-0.1.1-win-x64.zip

# 仓库开发环境：脚本在 scripts/ 下，zip 在 dist-release/ 下
node scripts/install.cjs --artifact=server \
  --zip=dist-release/vcpdeck-0.1.1-win-x64.zip \
  --app-dir="$HOME/.vcpdeck/launcher"

# 同机安装 Client：默认使用独立的 ~/.vcpdeck/launcher-client，不会与 Server 的 Launcher 冲突
node install.cjs --artifact=client --zip=vcpdeck-0.1.1-win-x64.zip --server-url=http://127.0.0.1:3001 --psk=<与 Server 相同的密钥>

# 远程 Linux 目标机：使用对应的 Linux 包
# node install.cjs --artifact=client --zip=vcpdeck-0.1.1-linux-x64.zip --server-url=http://<server-ip>:3001 --psk=<与 Server 相同的密钥>

# 非交互（CI/脚本）显式传参；缺省项自动随机生成
node install.cjs --artifact=server \
  --zip=vcpdeck-0.1.1-win-x64.zip \
  --psk=<密钥> --admin-password=<密码> \
  --db-url=file:/var/lib/vcpdeck/server.db

# 更换 Server 监听端口（默认 3001；写入 VCPDECK_PORT，改端口时同步 --server-url 与探活）
node install.cjs --artifact=server \
  --zip=vcpdeck-0.1.1-win-x64.zip \
  --port=8080

# 直接从 URL 安装，并指定 sha256 校验（可选）
node install.cjs --artifact=server \
  --zip=https://<server>/api/releases/0.1.1/file?platform=win-x64 \
  --sha256=<64hex>
```

> 只有 zip、没有脚本的场景（如仅从 Server `/api/releases` 下载 zip）：走第 4 节手动步骤（系统 unzip/tar 解压 + 写 current 指针 + 手铺环境变量）。

**启动参数就绪**：安装过程引导生成关键环境变量并写入 `<app-dir>/launcher.env`（PSK 与管理员密码缺省用 `crypto` 强随机生成，非 Windows 权限 600；敏感值仅打印一次请妥善保管）。server 构件额外写入 `DATABASE_URL` 与 `VCPDECK_RELEASES_DIR`（默认 `<app-dir>/releases`，**版本目录外绝对路径**——Launcher 按版本目录启动 server，相对路径会在自更新切换版本后漂移丢失）。安装完成后脚本会直接打印完整 Launcher 启动命令：

```bash
node --env-file="<app-dir>/launcher.env" "<app-dir>/dist/main.js"
```

安装脚本完成：解压 → 校验 Launcher 与业务构件完整 → 首次将 Launcher 安装到 `<app-dir>/dist/main.js`（已有 Launcher 保留）→ 复制 `manifest.json` + 对应构件（server/ 或 client/）到 `apps/<version>/` → 设置 current 指针 → 引导启动参数并写 `launcher.env` →（server，用引导确定的 `DATABASE_URL` 时）执行 `prisma db push` → 打印完整启动命令。

选项：`--version=<x.y.z>`（覆盖文件名推断，用于重命名为其他版本）、`--psk` / `--admin-password` / `--server-url` / `--client-id` / `--releases-dir` / `--port=<1-65535>`（显式参数，非 TTY 必需时使用；`--port` 仅 server 构件生效，写入 `VCPDECK_PORT` 覆盖默认 3001，需同步 client 的 `--server-url` 与 Server Launcher 的 `VCPDECK_PROBE_URL`）、`--no-env`（跳过 env 生成，保持纯安装）、`--skip-db`、`--force`（覆盖已存在版本目录）。目标机 client 未提供 `--server-url` 时会提示手动补写 `launcher.env` 的 `VCPDECK_SERVER`。

> Launcher 随发布 zip 提供，但安装后位于 `<app-dir>/dist/main.js`，不随业务版本切换覆盖；系统服务安装仍需由运维配置。

### 3.2 快速卸载脚本（`uninstall.cjs`）

`uninstall.cjs` 与发布 zip 平级提供于 `dist-release/` 目录（仓库内为 `scripts/uninstall.cjs`）。它只操作 `<app-dir>/apps/...`，与 zip 内容无关：

```bash
node scripts/uninstall.cjs --version=0.1.1 --app-dir="$HOME/.vcpdeck/launcher" --yes
node scripts/uninstall.cjs --current --app-dir="$HOME/.vcpdeck/launcher" --yes  # 卸载当前生效版本
node scripts/uninstall.cjs --version=0.1.1 --app-dir="$HOME/.vcpdeck/launcher" --dry-run  # 预览
```

卸载语义：删除 `apps/<version>/`（仅应用构件，版本目录外的持久数据不受影响）；若 current 指向被卸载版本，自动重定向到剩余最高版本，无剩余版本时清空指针（Windows `state.json` 写 `{"current":null}`，Linux 删除 symlink）。`--yes` 跳过交互确认；非交互终端自动执行。版本目录被运行中进程占用时（如 Windows 上 Server 正在跑）会报错并提示，需先停止进程再卸载。

## 4. 控制面主机（Server）部署与启动

> 用第 3.1 节的快速脚本即可完成安装（解压 + current 指针 + 建库）；下面给出不做脚本时的完整手动步骤，并说明启动所需环境变量。

```bash
# 不使用安装脚本时，先解压到临时目录，再按 manifest 安装 Launcher 和业务构件。
# 以下为 Linux（Bash）手动步骤；Windows 建议直接使用第 3.1 节安装脚本（手动步骤见下方 PowerShell 变体）。
APP_DIR=~/.vcpdeck/launcher
mkdir -p "$APP_DIR"
unzip -o dist-release/vcpdeck-0.1.1-linux-x64.zip -d "$APP_DIR/.staging"
mkdir -p "$APP_DIR/dist"
cp "$APP_DIR/.staging/launcher/dist/main.js" "$APP_DIR/dist/main.js"
mkdir -p "$APP_DIR/apps/0.1.1"
cp "$APP_DIR/.staging/manifest.json" "$APP_DIR/apps/0.1.1/manifest.json"
cp -R "$APP_DIR/.staging/server" "$APP_DIR/apps/0.1.1/server"
ln -sfn 0.1.1 "$APP_DIR/apps/current"

# 初始化数据库并准备 launcher.env 后，直接使用安装脚本打印的 Launcher 命令：
node --env-file="$APP_DIR/launcher.env" "$APP_DIR/dist/main.js"
```

Windows（PowerShell）手动步骤变体（current 指针为 `state.json`，不是 symlink）：

```powershell
$APP_DIR = "$HOME\.vcpdeck\launcher"
Expand-Archive -Path dist-release\vcpdeck-0.1.1-win-x64.zip -DestinationPath "$APP_DIR\.staging" -Force
New-Item -ItemType Directory -Force -Path "$APP_DIR\dist", "$APP_DIR\apps\0.1.1" | Out-Null
Copy-Item "$APP_DIR\.staging\launcher\dist\main.js" "$APP_DIR\dist\main.js"
Copy-Item "$APP_DIR\.staging\manifest.json" "$APP_DIR\apps\0.1.1\manifest.json"
Copy-Item -Recurse "$APP_DIR\.staging\server" "$APP_DIR\apps\0.1.1\server"
'{ "current": "0.1.1" }' | Set-Content -Encoding ascii "$APP_DIR\apps\state.json"
```

验证：

```bash
curl http://127.0.0.1:3001/api/status
# → {"serverVersion":"0.1.1","activeRelease":null}
```

> 不带 Launcher 也可直接 `node dist/main.js` 运行，但没有守护、自更新与失败回退；不建议作为生产常驻方式。

### PM2 托管 Launcher（可选）

生产长期运行可用 PM2 守护 **Launcher**（不是业务进程）：

```bash
pm2 start node --name vcpdeck-server-launcher -- \
  --env-file="$APP_DIR/launcher.env" "$APP_DIR/dist/main.js"
pm2 save
```

Windows（PowerShell）同一命令（换行符为反引号 `` ` ``，或写成一行）：

```powershell
pm2 start node --name vcpdeck-server-launcher -- "--env-file=$APP_DIR\launcher.env" "$APP_DIR\dist\main.js"
pm2 save
```

目标机 Client 同理（使用各自的 `launcher.env` 与 `dist/main.js`，`--name` 改为 `vcpdeck-client-launcher`）。

说明：自更新时 Launcher 会自行停止/切换业务进程，因此**只把 Launcher 交给 PM2**；完整 ecosystem 配置、开机自启、更新期间禁止重启 Launcher 等注意事项见 [`deployment.md`](./deployment.md) §4.6。

## 5. 目标机（Client）部署与启动

推荐登录驾驶台 `/releases`，确认当前 Server 同版本 Release 已完成，启用“Client 一键安装”，再复制对应平台固定命令。Linux 新安装使用 A2 systemd 系统级部署；Windows 安装器准备用户私有 Node.js、Client、Launcher、PM2 和登录自启，并等待 Server 验收。Linux 存量 PM2 安装必须显式使用 `--migrate` 迁移；显示名称和安装目录等 Windows 选项可直接回车使用默认值。

一键安装当前只支持 Windows 10/11、Server 2019+ x64，以及 Ubuntu 22.04+、Debian 12+、Rocky/AlmaLinux 9+ 和 Bazzite x64 + glibc + systemd。Linux A2 安装要求 root 或可用 sudo；入口默认关闭，启用后任何可访问 Server 的机器都能取得共享 PSK。

需要手工安装或排障时仍可使用第 3.1 节 `install.cjs`（Client 默认使用 `~/.vcpdeck/launcher-client`，Launcher 自动安装到 `<app-dir>/dist/main.js`）：

```bash
node install.cjs --artifact=client --zip=vcpdeck-0.1.1-linux-x64.zip \
  --server-url=http://<server-ip>:3001 --psk=<与 Server 相同的密钥>
```

安装完成后使用脚本打印的完整命令：

```bash
node --env-file="$HOME/.vcpdeck/launcher-client/launcher.env" \
  "$HOME/.vcpdeck/launcher-client/dist/main.js"
```

出现 `[vcpdeck] connected as <id>` 即连接成功。Client 以运行账户权限执行命令/文件/终端/Pi，应使用权限受控的专用账户。

Windows 一键安装默认可能将 PM2 放在用户私有目录，直接输入 `pm2` 可能提示找不到命令。重启 Client 时只重启 `vcpdeck-client-launcher`，具体 PowerShell 命令和 PM2/Node 路径见 [`operations.md`](./operations.md) §2；电脑重启后恢复 PM2 可执行安装器生成的 `pm2-resurrect.cmd`。

## 6. 验证通讯

> 以下为 Bash / Git Bash 语法；Windows PowerShell 请使用 `curl.exe`，并改用 cookie 文件携带会话（见下方变体）。

```bash
# 登录拿会话 cookie
COOKIE=$(curl -s -c - -X POST http://127.0.0.1:3001/api/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"<管理员密码>"}' \
  | grep vcpdeck_session | awk '{print $NF}')

# 1. Client 在线、版本与能力
curl -s -b "vcpdeck_session=$COOKIE" http://127.0.0.1:3001/api/clients
# → 应看到 online:true、clientVersion 与能力列表（exec,file.read,file.write,frp,agent.pi,terminal.pty）

# 2. 下发命令 Job（Server → Client 执行 → 结果回传）
JOB=$(curl -s -b "vcpdeck_session=$COOKIE" -X POST http://127.0.0.1:3001/api/jobs \
  -H "content-type: application/json" \
  -d '{"clientId":"<clientId>","type":"exec","payload":{"mode":"command","command":"echo hello && hostname"}}')
JOB_ID=$(echo "$JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).jobId))")

# 3. 查看结果（status 应为 done，stdout 含命令输出）
curl -s -b "vcpdeck_session=$COOKIE" http://127.0.0.1:3001/api/jobs/$JOB_ID
```

实测输出示例：`status: done`，`stdout: "hello ... <hostname>"`——即 Server 下发、Client 在目标机实际执行并回传结果，全链路打通。

Windows（PowerShell）验证变体（`curl.exe` + cookie 文件）：

```powershell
# 登录并把会话 cookie 保存到 cookies.txt
curl.exe -s -c cookies.txt -X POST http://127.0.0.1:3001/api/auth/login `
  -H "content-type: application/json" `
  -d '{"username":"admin","password":"<管理员密码>"}'

# Client 在线、版本与能力
curl.exe -s -b cookies.txt http://127.0.0.1:3001/api/clients
```

## 7. 日常发版（自动更新）

首次在 Frontend `/settings/tokens` 创建专用 CLI Token，并把 Token 值保存到本机 `VCPDECK_DEV_TOKEN` 环境变量（不要写入仓库或命令）后注册环境：

```bash
node packages/cli/dist/index.js env add dev \
  --server=http://<server>:3001 \
  --token-env=VCPDECK_DEV_TOKEN
node packages/cli/dist/index.js env use dev --local
node packages/cli/dist/index.js env current
node packages/cli/dist/index.js env check
```

`env check` 验证 Server 可达、Token 有效及其对应身份；个人资料修改用户名不会使该 Token 失效。密码环境仅作为旧配置兼容。

之后项目目录内直接使用默认环境发布，也可临时添加 `--env=dev`：

```bash
pnpm release --version=1.0.0
node packages/cli/dist/index.js release upload \
  dist-release/vcpdeck-1.0.0-win-x64.zip \
  dist-release/vcpdeck-1.0.0-linux-x64.zip \
  --wait --timeout=1800
```

Server 校验 sha256 → 两个平台构件齐备后自动编排：**Server 先自更新**（Launcher prepare → drain → 重启 → 探活版本一致）→ **再逐台更新在线 Client**（按各机器注册 os 选对应平台包）→ 失败自动回退上一版本。发布前必须备份数据库与 Storage。

完整的发布前准备、curl 上传方式、进度监控、完成核对、失败重试与手动回滚操作见 [`deployment.md`](./deployment.md) §9。

## 8. 常见问题速查

| 现象 | 原因与处置 |
| --- | --- |
| `/api/status` 无响应 | Server 未启动或端口 3001 被占用；查看 Launcher 日志 |
| Client 不显示 `connected` | `VCPDECK_SERVER` 可达性、两端 `VCPDECK_PSK` 不一致 |
| Client 在线但缺 `terminal.pty` | 目标机为 Alpine/musl（无预编译）或构件被裁剪 |
| 自动更新下载失败 | Linux 目标机缺 `unzip`；或上传时缺该平台构件 |
| 版本显示 `0.0.0` | 误用了开发构建（`pnpm build` 产物）；发布必须走 `pnpm release` |
| Launcher 报"尚未部署任何版本" | `apps/current` 未设置或指向不存在的版本目录 |
| `prisma db push` 报错 | 未在版本目录内执行，或未设置 `DATABASE_URL`；需 `prisma.config.cjs`（随包携带） |

## 9. 安全与边界提醒

- `VCPDECK_PSK` 与管理员密码必须随机生成并妥善保管，示例值仅用于本地演练；
- 生产必须 HTTPS + `VCPDECK_COOKIE_SECURE=true`；
- Server 默认监听 `3001`，可用 `VCPDECK_PORT` 覆盖；改端口时 Client `VCPDECK_SERVER` 与 Server Launcher `VCPDECK_PROBE_URL` 需同步指向新端口；
- Frontend 已随发布包打进 server 构件（`server/public/`），由 Server 同源托管（SPA 回退到 `index.html`），访问 `http://<host>:3001/` 即驾驶台；跨源部署仍可按 `deployment.md` §7 单独托管并设置 `VCPDECK_FRONTEND_ORIGIN`；
- 信任模型、凭据与敏感数据处理见 [`security.md`](./security.md)。
