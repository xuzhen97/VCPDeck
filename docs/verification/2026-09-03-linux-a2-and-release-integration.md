# 0.6.18 Linux A2 与 Release 集成验收记录

> 状态：Verification｜验收日期：2026-09-03｜适用版本：`0.6.18`｜Commit：`3774315`｜Tag：`v0.6.18`

本文记录本次 Linux Client A2 改造、虚拟机集成验收以及 `0.6.18` Release 自动更新的实际效果、测试方法、已通过项和未覆盖项。本文是时间点证据，不扩大 [`compatibility.md`](../compatibility.md) 中的长期支持声明。

## 1. 本次修改产生的效果

### 1.1 Linux Client 从用户级 PM2 改为系统级 A2 部署

Linux 全新安装不再把 Client 安装到执行安装命令的用户 Home，也不再依赖 PM2、user-service、linger、cron、登录脚本或 `nohup` 回退。安装器现在要求以 root 执行，或先完成本地 `sudo` 认证；权限条件不满足时直接以 `LINUX_SUDO_AUTH_FAILED` 失败关闭。

固定布局如下：

| 路径 | 用途 |
| --- | --- |
| `/opt/vcpdeck/client` | Client 应用、私有 Node.js、版本目录和 Launcher payload |
| `/var/lib/vcpdeck-client` | `client-id`、安装/迁移状态和运行状态 |
| `/var/lib/vcpdeck-client/home` | `vcpdeck` 账户的独立 HOME |
| `/etc/vcpdeck/client.env` | Server 地址、PSK 等运行环境，权限为 `0640 root:vcpdeck` |
| `/etc/sudoers.d/vcpdeck-client` | 专用账户的 sudo 授权 |
| `/etc/systemd/system/vcpdeck-client.service` | systemd 系统服务单元 |

systemd 只负责守护稳定 Launcher；Launcher 仍负责 Client 业务版本的启动、探活、切换和回退。因此，机器冷重启后无需任何用户登录，Client 可以由 systemd 自动恢复。

### 1.2 使用专用账户并显式标记 root 等价风险

安装器创建或核对专用 `vcpdeck` 账户，要求：

- 密码锁定；
- 登录 Shell 为 `/bin/bash`；
- HOME 为独立的 `/var/lib/vcpdeck-client/home`；
- 不复制旧用户的 `.pi`、`.ssh`、`.gitconfig`、Shell profile 或个人凭据。

按照 ADR-0023，该账户拥有：

```text
vcpdeck ALL=(ALL:ALL) NOPASSWD: ALL
```

Job、Terminal、Pi 等能力可通过 `sudo -n` 执行 root 命令。这是当前可信操作者模型下的 root-equivalent Client，不是安全沙箱。Client 会在启动时探测非交互 sudo，并通过协议上报：

- `capabilityDetails.privileged`：是否可用、是否非交互、运行身份；
- `installation`：系统级 A2、旧版 PM2 或未报告。

Server、Frontend 和 CLI 展示这些信息，不再根据 OS、用户名或历史记录猜测权限。旧 Client 没有新字段时显示为“未报告”。

### 1.3 存量 PM2 安装具备受控迁移边界

Linux 旧版 PM2 Client 可以通过 `--migrate` 进入 M1 迁移流程：

1. 发现旧 Client、旧 `client-id`、Server 关联和可用运行时；
2. 校验迁移源唯一性、Client ID、Server Origin、PM2 在线状态和 Release 状态；
3. 创建新 A2 现场并先以 verify-only 模式验证身份、版本和权限；
4. 新 systemd Client 以相同身份完成稳定注册和能力上报后，才停用旧 PM2；
5. 迁移前失败恢复旧 PM2；迁移后失败则保留现场并标记需要人工恢复。

迁移过程中禁止同一 Client ID 的新旧进程并发运行；无关 PM2 应用不得被删除或停用。

### 1.4 安装、发布和升级链路更可验证

Bootstrap → A2 installer → `install.cjs` → Client archive 形成完整校验链：

- Bootstrap 获取当前 Server 和 Release 元数据；
- 安装前校验 installer、低层 `install.cjs` 和 Client archive 的 SHA-256；
- 低层安装器使用绝对路径，不依赖当前工作目录；
- 安装失败保存 `failed` 状态和现场，重跑同一命令可以继续修复；
- sudoers 临时文件在目标目录同一文件系统内创建，避免 Bazzite `/etc` 子卷触发 `EXDEV`；
- Launcher systemd 升级使用受限 transient `systemd-run`，不在 Client service cgroup 内直接替换自身。

Windows 安装行为保持原有的用户级 Node.js/PM2/登录恢复模型，不因 Linux A2 改造而改变。

### 1.5 Release 自动更新结果

本次生成了：

```text
dist-release/vcpdeck-0.6.18-win-x64.zip
dist-release/vcpdeck-0.6.18-linux-x64.zip
```

构件已提交并推送到 `main` 和 `v0.6.18`，随后上传到生产 Server。生产编排最终结果为：

```text
Server: 0.6.18
Release: done
客户端成功: 10
客户端失败: 0
进行中: 0
待更新: 0
```

生产 Server 下载到的以下安装资产均与当前提交源码逐字节一致：

- `install-client-linux.cjs`；
- `install.cjs`；
- Linux Bootstrap。

## 2. 集成测试环境

### 2.1 虚拟机矩阵

虚拟机由 Windows 宿主机上的 VirtualBox + Vagrant 管理。下表记录本次验收使用的稳定拓扑，便于重新建立同等环境：

| 虚拟机 | 操作系统 | 私有地址 | 资源 | 目的 |
| --- | --- | --- | --- | --- |
| `jammy` | Ubuntu 22.04 | `172.28.100.181` | 2 vCPU / 2 GB | 已完成 A2 全新安装、注册和冷重启验收 |
| `bookworm` | Debian 12 | `172.28.100.182` | 2 vCPU / 2 GB | 预定的 Debian 验收，本文记录期尚未执行 |
| `rocky9` | Rocky Linux 9 x86_64 | `172.28.100.183` | 2 vCPU / 2 GB | 预定的 SELinux/systemd 验收，本文记录期尚未执行 |
| `almalinux9` | AlmaLinux 9 | `172.28.100.184` | 2 vCPU / 2 GB | 预定的 SELinux/systemd 验收，本文记录期尚未执行 |

宿主机在 `172.28.100.1:3001` 提供测试 Server。VM 通过 private network 访问宿主机；测试前需要保证宿主机防火墙允许 3001 入站，并在 VM 内验证：

```bash
curl -fsS http://172.28.100.1:3001/api/status
```

虚拟机前置条件：

- x86_64；
- PID 1 为 systemd；
- 已安装 VirtualBox 7.x 和 Vagrant 2.4.x；
- BIOS/UEFI 已启用硬件虚拟化；
- 测试使用 TTY 进入 VM，避免 sudo 门禁被非交互 SSH 影响。

### 2.2 Bazzite 真机补充环境

Bazzite 不使用上述 Vagrant box，使用真实 x86_64 主机：

```text
主机：xuzhen97-bazzite
地址：192.168.100.215
SELinux：Enforcing
```

该主机用于验证 rpm-ostree 分层、SELinux enforcing、`/etc` 独立 Btrfs 子卷、systemd 执行和真实冷重启。Bazzite 的 A2 验收指向本地测试 Server，不等同于生产环境中同名 Client 的迁移状态。

## 3. 虚拟机集成测试方法

### 3.1 启动测试 Server 和 VM

宿主机启动测试 Server 后，按需启动单台 VM，避免同时占用过多内存：

```bash
pnpm dev
vagrant up jammy
vagrant ssh -tt jammy
```

进入 VM 后先检查：

```bash
ps -p 1 -o comm=
getent hosts 172.28.100.1
curl -fsS http://172.28.100.1:3001/api/status
```

输出中的 PID 1 应为 `systemd`，Server status 请求应成功。

### 3.2 执行公开 Bootstrap 和构件校验

在 VM 中使用与 `/releases` 页面同形态的 Bootstrap 命令，Server Origin 指向测试 Server：

```bash
curl -fsSL \
  http://172.28.100.1:3001/api/client-installer/install-client-bootstrap.sh \
  -o /tmp/vcpdeck-install-client-bootstrap.sh
bash /tmp/vcpdeck-install-client-bootstrap.sh \
  --server-origin=http://172.28.100.1:3001
```

实际验收重点不是只看命令返回码，而是确认以下顺序真实发生：

1. preflight 取得 Server 版本、Release 版本、平台和各构件 SHA-256；
2. Bootstrap 下载并校验 A2 installer；
3. A2 installer 校验 `install.cjs` 和 Client archive；
4. 低层安装器完成构件展开和 Launcher 安装；
5. 安装器写入固定目录、账户、环境文件、sudoers 和 systemd unit；
6. Client 启动并向 Server 注册；
7. 安装状态写为 `done`。

测试过程中只使用本地隔离测试版本和合成数据；密码、PSK、Token、签名 URL 和文件正文不写入文档或命令参数。

### 3.3 检查 A2 固定布局、账户和权限

安装成功后，在 VM 内检查服务和系统对象：

```bash
systemctl is-enabled vcpdeck-client.service
systemctl is-active vcpdeck-client.service
systemctl show vcpdeck-client.service \
  -p User -p ExecMainStatus -p NRestarts

getent passwd vcpdeck
passwd -S vcpdeck
visudo -cf /etc/sudoers.d/vcpdeck-client
sudo -u vcpdeck sudo -n id -u

stat /opt/vcpdeck/client
stat /var/lib/vcpdeck-client
stat /var/lib/vcpdeck-client/home
stat /etc/vcpdeck/client.env
stat /etc/sudoers.d/vcpdeck-client
stat /etc/systemd/system/vcpdeck-client.service
```

验收条件：

- service 为 `enabled` 且 `active`；
- `vcpdeck` 账户存在、密码锁定、Shell 和 HOME 符合要求；
- `visudo` 校验通过；
- `sudo -u vcpdeck sudo -n id -u` 返回 `0`；
- 固定目录不为符号链接，类型、属主和权限符合 A2 约束；
- `NRestarts=0`、`ExecMainStatus=0`，没有启动循环。

### 3.4 从 Server 侧验证注册和能力投影

通过 Frontend 或 CLI 检查目标 Client：

```bash
vcpdeck clients list --env=<test-environment>
```

应确认：

- `online=true`；
- `clientVersion` 与 Server/Release 一致；
- `installation.mode=systemd` 或等价的系统级部署标识；
- `capabilityDetails.privileged.available=true`；
- `mode= sudo-all`、`nonInteractive=true`、`runAsUser=root`；
- Client ID 持久化且重启前后不变。

### 3.5 冷重启和无人登录恢复

不在重启后打开交互式用户会话，直接执行：

```bash
vagrant reload jammy
vagrant ssh jammy -c \
  "systemctl is-enabled vcpdeck-client.service && systemctl is-active vcpdeck-client.service"
```

随后从 Server 侧重新查询 Client。通过条件为：

- systemd 自动启动 Client；
- 不需要 `vagrant ssh` 后执行登录脚本或手工 `pm2 resurrect`；
- Client 自动重新注册并恢复 `online=true`；
- Client ID、版本和 privileged capability 保持一致。

Ubuntu 22.04 和 Bazzite 均完成了这条冷重启链路。Bazzite 另外检查：

```bash
getenforce
journalctl -u vcpdeck-client.service --no-pager
```

验收时 SELinux 保持 `Enforcing`，未发现新的启动失败或相关 AVC denied。

### 3.6 卸载和 purge

卸载脚本的单元测试已覆盖普通卸载和 `--purge` 差异：普通卸载移除运行现场但保留身份相关数据，`--purge` 再清理 Release 缓存和迁移状态。本文记录期尚未在 disposable VM 上执行完整真实卸载/purge；因此不能把脚本测试等同于真实系统卸载验收。

## 4. M1 迁移测试方法和实际边界

正向迁移必须让旧 PM2 Client 和新 A2 Client 指向同一个测试 Server，步骤如下：

1. 用旧版本 Bootstrap 安装 PM2 Client；
2. 记录并确认旧 Client ID、Server Origin、PM2 进程和无关 PM2 应用；
3. 用新 Bootstrap 加 `--migrate=true`；
4. 验证 verify-only 阶段不会挂载 Job、Files、Terminal、Pi、FRP 操作处理器；
5. 验证新 systemd Client 以相同 Client ID 稳定上线后，旧 PM2 才被停用；
6. 制造新服务启动/注册失败，验证旧 PM2 自动恢复；
7. 确认无关 PM2 应用仍在线，最后执行冷重启复核。

本次已完成的 M1 自动化和负向验证包括：

- 多迁移源未显式选择时拒绝：`LINUX_MIGRATION_AMBIGUOUS`；
- 普通 sudo 用户不能越权选择其他用户的迁移源；
- 非法 Client ID、PM2 非 online、进行中 Release 均拒绝；
- 旧 PM2 Server 与新 A2 Server 不同的场景返回 `LINUX_MIGRATION_SERVER_MISMATCH`，不执行切换；
- happy-path 的阶段顺序和失败回滚由测试夹具验证。

生产 Bazzite 的旧 PM2 Client 指向生产 Server，而此前 A2 真机验收指向本地 Server。为遵守 Server mismatch 安全门禁，本次没有在生产 Bazzite 上强行执行正向迁移。生产 Bazzite 随 `0.6.18` 业务 Release 更新后仍报告 `legacy-pm2`，这是有意保留的真实状态，不能解读为 A2 迁移完成。

## 5. 自动化回归与 Release 验收结果

### 5.1 定向脚本测试

| 测试 | 结果 |
| --- | ---: |
| `scripts/install-client-linux.test.cjs` | 23 通过，1 跳过 |
| `scripts/install.test.cjs` | 22 通过 |
| `scripts/uninstall-client-linux.test.cjs` | 4 通过 |
| `scripts/upgrade-launcher-systemd.test.cjs` | 5 通过 |
| Bootstrap shell 语法和测试 | 通过 |
| Release installer asset 测试 | 2 通过 |
| `node --check scripts/install-client-linux.cjs` | 通过 |
| `git diff --check` | 通过 |

唯一跳过项是需要特定真实运行时复制条件的安装器测试，不影响其余断言。

### 5.2 包级和项目级测试

本次回归结果：

- Shared：113 项通过；
- Server：557 项通过；
- SDK：48 项通过；
- Launcher：70 项通过；
- Client：268 项通过；
- 项目集成测试：79/79 通过；
- Server、Client、Launcher、Frontend、CLI 构建通过；
- 相关 TypeScript LSP/诊断无错误；
- `lens_diagnostics` 无新增问题。

`pnpm lint` 本次没有计入通过：当前仓库环境缺少可用的 lint executable（命令报告 ESLint executable 缺失），未因此修改业务代码。

### 5.3 0.6.18 Release 端到端结果

执行流程为：

```bash
pnpm release --version=0.6.18

git commit -m "发布 v0.6.18 并完成 Linux A2 部署"
git tag -a v0.6.18 -m "发布 v0.6.18"
git push origin main v0.6.18

node skills/vcpdeck/vcpdeck.cjs release upload \
  dist-release/vcpdeck-0.6.18-win-x64.zip \
  dist-release/vcpdeck-0.6.18-linux-x64.zip \
  --env=prod --wait --timeout=1800
```

上传后观察到完整状态链：

```text
uploaded → updating_server → updating_clients → done
```

最终 Server 为 `0.6.18`，10 台 Client 成功、0 台失败。该验证覆盖构件上传、Server 更新、Client 分平台更新、Client 重连和最终状态汇总；它验证的是 Release 业务更新链，不代表生产 Bazzite 已完成 A2 迁移。

## 6. 结果汇总和未覆盖项

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Ubuntu 22.04 A2 全新安装 | 通过 | Vagrant VM；包含注册、固定布局、账户、sudo、systemd |
| Ubuntu 22.04 冷重启无人登录恢复 | 通过 | `enabled/active`，Client 自动上线 |
| Bazzite x64 A2 全新安装 | 通过 | 真机；SELinux Enforcing、Btrfs 子卷、systemd 和权限均核验 |
| Bazzite 冷重启无人登录恢复 | 通过 | Client 自动注册，未发现新的启动失败/AVC |
| Debian 12 真实安装 | 未执行 | 仍需独立验收 |
| Rocky Linux 9 真实安装 | 未执行 | 仍需独立验收 |
| AlmaLinux 9 真实安装 | 未执行 | 仍需独立验收 |
| 同一 Server 的 M1 正向迁移 | 未执行 | 当前生产 Bazzite 与本地 A2 验收 Server 不同，触发安全门禁 |
| M1 负向 Server mismatch | 通过 | 返回稳定错误且未破坏旧安装 |
| Linux 真实卸载和 `--purge` | 未执行 | 目前为脚本级测试通过 |
| Windows 真实安装 | 未执行 | Windows 代码路径保持不变 |
| 生产 `0.6.18` Release 自动更新 | 通过 | Server + 10 个 Client，失败 0 |

因此当前可以准确宣称：**Ubuntu 22.04 和 Bazzite x64 的 Linux A2 全新安装、冷重启和无人登录自动启动已通过；`0.6.18` 生产 Release 已完成 Server 与 10 台 Client 的自动更新。** 在 Debian、Rocky、AlmaLinux 和同一 Server 的 M1 正向迁移完成真实验收前，不宣称整个 Linux 支持矩阵或生产 Bazzite A2 迁移已完成。

## 7. 安全与复现注意事项

- 不要把真实密码、PSK、Token、OAuth code、SSH 私钥或签名 URL 写入命令参数、日志或本文；
- 生产上传前先提交并推送代码、Tag 和构件，避免 Server 使用未核对的资产触发自动更新；
- M1 测试必须使用同一个隔离 Server；Server Origin 不一致时应保留 `LINUX_MIGRATION_SERVER_MISMATCH` 拒绝结果，不得绕过；
- 测试结束后删除 Vagrant 私钥、SSH askpass、下载的临时构件和诊断脚本；
- root-equivalent Client 只适用于接受主机接管风险的可信节点，Server 审计不等同于完整主机审计；
- 重新执行本矩阵前，应以当前代码、`docs/deployment.md`、ADR-0023 和本文的“未执行”表为准，并重新核对宿主机、Server 和各测试目标的实际状态。
