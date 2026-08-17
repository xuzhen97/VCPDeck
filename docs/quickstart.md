# VCPDeck 快速开始：构建 → 部署 → Server/Client 通讯

> 状态：Current｜维护责任：发布/运维维护者｜最后核验：2026-08-17｜适用版本：当前 `main`

本文是从零到"Server 与 Client 双向通讯"的最小可验证路径，所有命令均经过 Windows（Git Bash）端到端演练。完整边界、配置表和升级细节见 [`deployment.md`](./deployment.md)；构件打包决策见 [`ADR-0012`](./adr/0012-bundled-release-artifacts.md)；更新协议见 [`design/release-and-update.md`](./design/release-and-update.md)。

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

每个包同时含 `server/` 与 `client/` 两套构件。构建脚本会打印各包 sha256 与上传命令。

## 3. 部署布局（Launcher apps 结构）

Launcher 以 `apps/<version>/` 保存版本目录，用 current 指针（Linux symlink / Windows state 文件）选择当前版本：

```text
<VCPDECK_APP_DIR>/            # 默认 ~/.vcpdeck/launcher
├── control.json              # Launcher 启动后自动生成（控制通道端口与 Token）
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

### 3.1 快速安装脚本（`scripts/install.cjs`）——推荐

把发布 zip 安装为版本目录并设置 current 指针、初始化数据库，一条命令完成。支持本地文件或 http(s) URL 下载：

```bash
# 控制面主机：安装 Server 构件并初始化数据库
node scripts/install.cjs --artifact=server \
  --zip=dist-release/vcpdeck-0.1.1-win-x64.zip \
  --app-dir=~/.vcpdeck/launcher \
  --db-url=file:/var/lib/vcpdeck/server.db

# 目标机：安装 Client 构件（无需 db）
node scripts/install.cjs --artifact=client \
  --zip=dist-release/vcpdeck-0.1.1-linux-x64.zip \
  --app-dir=~/.vcpdeck/launcher

# 直接从 URL 安装，并指定 sha256 校验（可选）
node scripts/install.cjs --artifact=server \
  --zip=https://<server>/api/releases/0.1.1/file?platform=win-x64 \
  --sha256=<64hex> --db-url=file:/var/lib/vcpdeck/server.db
```

安装脚本完成：解压 → 校验构件完整 → 复制 `manifest.json` + 对应构件（server/ 或 client/）到 `apps/<version>/` → 设置 current 指针 →（server 且给了 `--db-url` 或环境变量 `DATABASE_URL` 时）执行 `prisma db push` → 打印下一步启动命令。

选项：`--version=<x.y.z>`（覆盖文件名推断，用于重命名为其他版本）、`--skip-db`、`--force`（覆盖已存在版本目录）。不指定 `--db-url` 时 server 会跳过建库并提示手动初始化。

> 脚本只安装应用构件；Launcher 本身与系统服务仍需按第 4 节和 `deployment.md` 准备。

### 3.2 快速卸载脚本（`scripts/uninstall.cjs`）

```bash
node scripts/uninstall.cjs --version=0.1.1 --app-dir=~/.vcpdeck/launcher --yes
node scripts/uninstall.cjs --current --app-dir=~/.vcpdeck/launcher --yes  # 卸载当前生效版本
node scripts/uninstall.cjs --version=0.1.1 --app-dir=~/.vcpdeck/launcher --dry-run  # 预览
```

卸载语义：删除 `apps/<version>/`（仅应用构件，版本目录外的持久数据不受影响）；若 current 指向被卸载版本，自动重定向到剩余最高版本，无剩余版本时清空指针（Windows `state.json` 写 `{"current":null}`，Linux 删除 symlink）。`--yes` 跳过交互确认；非交互终端自动执行。版本目录被运行中进程占用时（如 Windows 上 Server 正在跑）会报错并提示，需先停止进程再卸载。

## 4. 控制面主机（Server）部署与启动

> 用第 3.1 节的快速脚本即可完成安装（解压 + current 指针 + 建库）；下面给出不做脚本时的完整手动步骤，并说明启动所需环境变量。

```bash
# 1. 解压（Windows 系统 bsdtar 或 PowerShell Expand-Archive；Linux 用 unzip）
APP_DIR=~/.vcpdeck/launcher
mkdir -p "$APP_DIR/apps/0.1.1"
tar -xf dist-release/vcpdeck-0.1.1-win-x64.zip -C "$APP_DIR/apps/0.1.1"

# 2. current 指针（Linux 用 symlink，Windows 写 state.json）
#    Linux: ln -s 0.1.1 "$APP_DIR/apps/current"
echo '{"current":"0.1.1"}' > "$APP_DIR/apps/state.json"

# 3. 初始化数据库（Launcher 首次启动不执行 preStart，preStart 只在自动更新时运行）
cd "$APP_DIR/apps/0.1.1/server"
DATABASE_URL="file:/var/lib/vcpdeck/server.db" \
  node node_modules/prisma/build/index.js db push

# 4. 用 Launcher 启动（守护、崩溃重启、自动更新与回退）
cd ~/vcpdeck  # Launcher 所在目录
VCPDECK_APP_DIR="$APP_DIR" \
VCPDECK_ARTIFACT="server" \
VCPDECK_PSK="<强随机密钥，与 Client 一致>" \
VCPDECK_ADMIN_PASSWORD="<首次启动设置管理员密码>" \
VCPDECK_COOKIE_SECURE="false" \          # 生产 HTTPS 时必须 true
DATABASE_URL="file:/var/lib/vcpdeck/server.db" \
VCPDECK_RELEASES_DIR="/var/lib/vcpdeck/releases" \
node packages/launcher/dist/main.js
```

验证：

```bash
curl http://127.0.0.1:3001/api/status
# → {"serverVersion":"0.1.1","activeRelease":null}
```

> 不带 Launcher 也可直接 `node dist/main.js` 运行，但没有守护、自更新与失败回退；不建议作为生产常驻方式。

## 5. 目标机（Client）部署与启动

每台目标机执行（解压对应平台包，保留 `client/` 构件）：

```bash
APP_DIR=~/.vcpdeck/launcher
mkdir -p "$APP_DIR/apps/0.1.1"
tar -xf dist-release/vcpdeck-0.1.1-linux-x64.zip -C "$APP_DIR/apps/0.1.1"
# Linux: ln -s 0.1.1 "$APP_DIR/apps/current"；Windows: state.json 同 Server

VCPDECK_APP_DIR="$APP_DIR" \
VCPDECK_ARTIFACT="client" \
VCPDECK_SERVER="http://<server-ip>:3001" \
VCPDECK_PSK="<与 Server 相同的密钥>" \
VCPDECK_CLIENT_ID="可选固定机器名" \
node packages/launcher/dist/main.js
```

出现 `[vcpdeck] connected as <id>` 即连接成功。Client 以运行账户权限执行命令/文件/终端/Pi，应使用权限受控的专用账户。

## 6. 验证通讯

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

## 7. 日常发版（自动更新）

```bash
pnpm release --version=1.0.0
node packages/cli/dist/index.js release upload \
  dist-release/vcpdeck-1.0.0-win-x64.zip \
  dist-release/vcpdeck-1.0.0-linux-x64.zip \
  --server=http://<server>:3001 --username=admin --password=<密码>
```

Server 校验 sha256 → 两个平台构件齐备后自动编排：**Server 先自更新**（Launcher prepare → drain → 重启 → 探活版本一致）→ **再逐台更新在线 Client**（按各机器注册 os 选对应平台包）→ 失败自动回退上一版本。发布前必须备份数据库与 Storage。

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
- Server 固定监听 `3001`（当前无端口覆盖变量）；
- Frontend 不在发布包内，需单独构建部署并与 Server 同版本（见 `deployment.md` §7）；
- 信任模型、凭据与敏感数据处理见 [`security.md`](./security.md)。
