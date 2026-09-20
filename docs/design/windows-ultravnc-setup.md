# Windows 目标机 UltraVNC 安装与配置示例

> 状态：Current｜维护责任：运维/发布维护者｜最后核验：2026-09-20｜适用版本：`0.10.5` / 当前 `main`
>
> 本文是**操作示例**：记录在 Windows 目标机上安装并配置受控 UltraVNC 的完整可复现步骤，以及实测得到的坑与判据。
> 长期决策（为什么固定 UltraVNC、为什么不自建会话内抓屏组件）见 [`ADR-0028`](../adr/0028-windows-desktop-capture-engine-in-session-vnc.md)；远程桌面前端行为见 [`p2p-tunnel.md`](./p2p-tunnel.md)；运维边界见 [`operations.md`](../operations.md) §9。
>
> **本文不包含任何口令值**：口令由操作者现场通过 `setpasswd.exe` 设置，不得写入文档、命令文本或提交记录。

## 1. 适用范围与非目标

适用：

- Windows 10/11 x64（示例环境：Windows 11 build 26200）目标机；
- 需要让 VCPDeck「远程桌面」Tab 通过 P2P 隧道查看/操作该机桌面；
- 目标机具备交互登录会话与活动显示输出（无显示器时需 HDMI 假负载或虚拟显示器驱动）。

非目标：

- 不覆盖 Linux 桌面；
- 不覆盖 Launcher/Client 自身的安装（见 [`deployment.md`](../deployment.md)）；
- **不实现多显示器切换**：UltraVNC 的 `SetSW` 客户端扩展目前**尚未在 VCPDeck 前端接入**，本示例只保证「完整桌面可看可操作」。精确切屏属后续独立工作。
- 不把 VNC 暴露到局域网或公网（见 §7 安全边界）。

## 2. 为什么是 UltraVNC

- 抓屏必须发生在**目标机交互会话内**；Windows Client 以 `NT AUTHORITY\SYSTEM` 运行在 Session 0，没有交互桌面（见 ADR-0028）。
- UltraVNC 以**服务模式**运行时，服务进程在 Session 0 接受连接，并由其会话内组件完成实际抓屏/输入注入——这正是需要的形态（实测见 §6 判据 4）。
- UltraVNC 自带 **DDEngine** 抓屏引擎（`ddengine64.dll`）与虚拟显示器支持（`UVncVirtualDisplay64`），是「多屏/无物理显示器」场景的前提。
- 存在 `SetSW` 扩展，为将来真正的按显示器切换留出路径（超 VNC 自身多屏合并桌面的能力）。

## 3. 前置条件

| 项 | 要求 |
| --- | --- |
| 权限 | 安装与配置需**管理员/SYSTEM** 身份。经 VCPDeck `jobs run` 执行时身份为 `NT AUTHORITY\SYSTEM`，可满足；本地交互安装需**已提升**的 PowerShell |
| 网络 | 目标机能访问官方下载域 `uvnc.eu`（安装页 `uvnc.com` 会跳转到该域） |
| 端口 | `5900` 必须空闲。**先停掉其它 VNC 服务端**，否则 UltraVNC 可能静默改用其它端口（见 §5 的 `AutoPortSelect`） |
| 版本 | 示例锁定 UltraVNC **1.8.3.0 x64**；升级版本须重新走 §4 的来源校验与 §6 验收 |

## 4. 获取并验证安装包

### 4.1 从官方页面取得真实直链，不要拼 URL

官方下载页（`https://uvnc.com/downloads/ultravnc/172-ultravnc-1-8-3-0.html`）的「Download」是**带许可同意复选框的 POST 表单**，提交后返回一个只含跳转脚本的中间页，真实文件地址在其中：

```text
https://uvnc.eu/download/1800/UltraVNC_1830_x64_Setup.exe
```

同一中间页还给出该版本所有构件的官方 SHA-256。**必须以官方公布的哈希为准**，不要凭经验拼 URL 或只信文件名。

### 4.2 校验（两项都要过）

```powershell
$url = 'https://uvnc.eu/download/1800/UltraVNC_1830_x64_Setup.exe'
$out = 'C:\ProgramData\VCPDeck\vnc-switch\UltraVNC_1830_X64_Setup.exe'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 600 -UseBasicParsing
Get-FileHash -Algorithm SHA256 $out            # 必须等于官方公布值
Get-AuthenticodeSignature $out | Format-List   # Status 必须为 Valid，并核对签名主体
```

2026-09-20 实测值：

| 项 | 值 |
| --- | --- |
| 文件 | `UltraVNC_1830_x64_Setup.exe` |
| 大小 | 6,239,336 B（magic `4d5a`，真实 PE） |
| SHA-256 | `e9c22419ef3128a707b0d004a2c58e25459528c5c12d104dea56e5e662bd131e`（与官方公布值一致） |
| Authenticode | `Valid`，签名主体 `CN="Open Source Developer, Rudi De Vos"`，签发者 `Certum Code Signing 2021 CA` |
| 版本信息 | ProductName `UltraVNC`，ProductVersion/FileVersion `1.8.3.0`，CompanyName `uvnc` |
| 许可 | GNU GPL v3（源码见 `github.com/ultravnc/UltraVNC`）。VCPDeck **不打包**该软件，仅在目标机上独立安装 |

> 注意：签名证书有有效期（实测该证书 2026-09-27 到期）。证书到期或更换后，**以官方公布 SHA-256 + 官方页面取得的直链**作为完整性锚点，不以证书有效期为唯一依据。

## 5. 安装与配置

### 5.1 正确的静默安装参数

```powershell
Start-Process 'C:\ProgramData\VCPDeck\vnc-switch\UltraVNC_1830_X64_Setup.exe' `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait
```

**只用默认组件集即可。** 实测反例（务必避免）：

- `UltraVNC` 仓库 `main` 分支的 `UltraVNC_installer_x64.iss` 里写着 `/COMPONENTS=UltraVNC_Server`、`/TYPE=server_silent`，但**发布版 1.8.3.0 的组件名与类型名与之不一致**。用这些参数会得到**空组件集**：安装器 `exit 0`，目录里却只有 `Changes.txt` / `Info.txt` / `Licence.txt` / `unins000.*`，**没有 `winvnc.exe`**。
- 一旦出现这种残缺安装，**必须先用 `unins000.exe /VERYSILENT` 卸载并清空目录**，否则再次静默运行会进入「维护模式」而什么也不做。

安装位置（**以卸载表为准，不要推断**）：

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'UltraVNC' } | Select-Object DisplayName,DisplayVersion,InstallLocation
```

实测安装目录为 **`C:\Program Files\uvnc\UltraVNC\`**（发布者目录名解析为 `uvnc`，而不是 `.iss` 中写的 `uvnc bvba`）。应包含 `winvnc.exe`、`vncviewer.exe`、`setpasswd.exe`、`ddengine64.dll`、`UVncVirtualDisplay64` 等。

### 5.2 先写配置，再启动服务（顺序很重要）

UltraVNC 的出厂默认是 `AllowLoopback=0`（**禁止**来自 localhost 的连接）且 `LoopbackOnly=0`（**监听所有网卡**）。**先启动服务会既让 VCPDeck 连不上、又把桌面暴露到局域网**。因此必须先落配置。

**权威配置文件是 `C:\ProgramData\UltraVNC\ultravnc.ini`**（`setpasswd.exe` 也写这里）。应用目录下的同名文件在被实测中并非生效来源；为稳妥可两处写同样内容，但以 ProgramData 为准。

```powershell
$ini = @"
[ultravnc]

[admin]
PortNumber=5900
AutoPortSelect=0
AllowLoopback=1
LoopbackOnly=1
MSLogonRequired=0
QueryAccept=0
FileTransferEnabled=0
AllowShutdown=0
HTTPConnect=0
"@
New-Item -ItemType Directory -Force -Path 'C:\ProgramData\UltraVNC' | Out-Null
Set-Content -LiteralPath 'C:\ProgramData\UltraVNC\ultravnc.ini' -Value $ini -Encoding ASCII
```

关键键语义（官方文档原文含义，容易反直觉）：

| 键 | 语义 | 取值理由 |
| --- | --- | --- |
| `AllowLoopback` | **默认 `0` = 禁止来自 localhost 的连接**；`1` = 允许 | **必须 `1`**：VCPDeck 隧道正是从目标机回环连入，用默认值会直接连不上 |
| `LoopbackOnly` | 设为 `1` 时只接受本地连接，并**覆盖** `AllowLoopback` 与 `AuthHosts` | 取 `1` 实现「仅回环」 |
| `AutoPortSelect` | 默认 `1`：5900 被占用时**自动顺延到 5901** | **必须 `0`**：否则端口被静默改掉，而 VCPDeck 固定连 5900，故障表现为「莫名连不上」 |
| `PortNumber` | 监听端口 | `5900` |
| `MSLogonRequired` | `0` = 用 VNC 口令；`1` = 用 Windows 账户 | 取 `0` |
| `QueryAccept` | 是否向服务端使用者弹窗请求允许连接 | 取 `0`（无交互弹窗） |
| `FileTransferEnabled` | VNC 自带文件传输 | 取 `0`；文件传输走 VCPDeck 自身的 Files 能力 |
| `AllowShutdown` | 是否允许远程关机/重启 | 取 `0`；远程电源操作不由此通道承担 |

### 5.3 口令：必须设置，且只能用 `setpasswd.exe`

**UltraVNC 在未设置口令时会拒绝一切连接**（实测：安全类型数量为 `0`，并回 `This server does not have a valid password enabled...`），因此「不设口令」不可行。

同时实测确认：**UltraVNC 1.8.x 的 `passwd=` 存储格式不是经典的 8 字节位反转**（实测某机为 18 个十六进制字符 / 9 字节，而按经典算法对同一口令算出的值完全不同）。因此：

- **不要**手工计算 hex 写入 `passwd=`；
- 必须用随附工具设置：

```powershell
& 'C:\Program Files\uvnc\UltraVNC\setpasswd.exe' '<口令>'
```

> 通过 VCPDeck `jobs run` 执行时，`setpasswd.exe <口令>` 会把口令写进 Job 命令与记录。若不愿如此，请在目标机本地（已提升的 PowerShell / 交互控制台）执行该命令，再回到本流程继续。口令值不得写入本文档或提交记录。

### 5.4 注册并启动服务

```powershell
$wv = 'C:\Program Files\uvnc\UltraVNC\winvnc.exe'
if (-not (Get-Service uvnc_service -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $wv -ArgumentList '-install' -Wait
}
sc.exe start uvnc_service        # 用 sc.exe，不要用 Stop-Service -Force
```

要点：

- 服务名固定为 **`uvnc_service`**，注册后应为 `StartMode=Auto`；
- **配置改动后不要依赖 `Restart-Service`**：实测真正监听的会话内实例不会因此重载配置。可靠做法是**停服务 + 杀净所有 `winvnc` 进程 + 再起服务**；
- **不要用 `Stop-Service -Force`**：实测会卡在 `STOP_PENDING` 并把远端 Job 拖到超时。改用 `sc.exe stop` / `sc.exe start` 加**有界轮询**：

```powershell
sc.exe stop uvnc_service | Out-Null
Get-Process winvnc -ErrorAction SilentlyContinue | Stop-Process -Force
sc.exe start uvnc_service | Out-Null
for ($i=0; $i -lt 25; $i++) { if (sc.exe query uvnc_service | Select-String 'RUNNING') { break }; Start-Sleep 1 }
```

## 6. 验收判据（四条全过才算完成）

| # | 判据 | 命令/方法 | 期望 |
| --- | --- | --- | --- |
| 1 | 服务已注册且自启 | `sc.exe query uvnc_service` | `STATE : 4 RUNNING`，`StartMode = Auto` |
| 2 | **仅回环监听** | `Get-NetTCPConnection -LocalPort 5900 -State Listen` | 只有 `127.0.0.1`（**不得出现 `0.0.0.0` 或 `::`**） |
| 3 | 确实在讲 RFB | TCP 连 `127.0.0.1:5900` 后读 12 字节 | 返回 `RFB 003.008` |
| 4 | 会话内抓屏组件在位 | `Get-Process winvnc` 的 `SessionId` | 同时存在 Session 0（服务宿主）与 Session 1（交互会话内抓屏）；这正是 ADR-0028 要求的形态 |
| 5 | 口令已生效且可用 | 安全类型列表 + 一次真实认证 | 安全类型含 `2`（VNC auth）且不含 `1`（None）；用口令完成认证后 4 字节结果为 `0` |

第 2 条是**安全红线**：不满足时必须立即停服，不要「先放一会再修」。

## 7. 安全边界

- **只监听回环**：外部只能经 VCPDeck 身份认证 + 临时 P2P 隧道进入；VNC 口令只是纵深防御，不是唯一边界。
- **口令必须设置**（超 VNC 强制），且不建议多机复用同一口令——口令一旦泄露，会同时降低所有复用机器的纵深防御强度。
- 关闭 `FileTransferEnabled`、`AllowShutdown`，减少这条通道能触发的动作面。
- 抓屏与输入注入继承目标机交互会话的权限，不是沙箱。
- 安装包来源必须两项校验通过（官方 SHA-256 + Authenticode）；不通过不得安装。

## 8. 回滚与卸载

```powershell
# 停服
sc.exe stop uvnc_service
Get-Process winvnc -ErrorAction SilentlyContinue | Stop-Process -Force
# 卸载（目录以卸载表 InstallLocation 为准）
& 'C:\Program Files\uvnc\UltraVNC\unins000.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

替换旧 VNC 服务端时（例如从 TigerVNC 迁移）注意：

- 卸载器可能**残留服务注册项**（`Get-CimInstance Win32_Service | Where-Object Name -match 'vnc'` 仍能看到指向已删除 exe 的条目）。用 `sc.exe delete <名称>` 清理，否则每次开机都会留下失败记录；
- 旧服务端的**用户级自启项**（`HKCU\...\Run`）不会被卸载器清理，必须显式删除，否则用户下次登录会再次抢占 5900。

## 9. 已知坑速查

| 现象 | 真实原因 | 处理 |
| --- | --- | --- |
| 安装器 `exit 0` 但目录里没有 `winvnc.exe` | 使用了与发布版不符的 `/COMPONENTS` / `/TYPE`，得到空组件集 | 卸载残缺安装并清空目录后，只用 `/VERYSILENT` 等基础参数重装 |
| 找不到安装目录 | 凭 `.iss` 推断路径（`uvnc bvba`） | 以卸载表 `InstallLocation` 为准（实测为 `uvnc\UltraVNC`） |
| 浏览器连上但立刻被拒，提示没有有效口令 | UltraVNC 强制要求口令 | 用 `setpasswd.exe` 设置口令 |
| VCPDeck 连不上，端口像是「没开」 | `AllowLoopback` 默认 `0` 禁止了回环连接 | 显式设 `AllowLoopback=1`，或 `LoopbackOnly=1` |
| 端口莫名从 5900 变成 5901 | `AutoPortSelect` 默认 `1` 自动顺延 | 设 `AutoPortSelect=0`，并先释放 5900 |
| 改完配置不生效 | 会话内 winvnc 实例不随服务重启重载配置 | 杀净 `winvnc` 进程后再起服务 |
| 远端 Job 卡死直到超时、服务停在 `STOP_PENDING` | 使用了 `Stop-Service -Force` | 改用 `sc.exe stop/start` + 有界轮询 |

## 10. 经 VCPDeck 远程执行时的注意事项

- `jobs run` 的命令经 `cmd.exe` 传递，**整条命令行上限约 8191 字符**。用 `-EncodedCommand` 内嵌脚本时，脚本原文需大致 **≲2900 字节**（UTF-16LE → base64 约 2.7 倍膨胀）；超限的表现是 stdout 为空、stderr 返回 GBK 乱码的「命令行太长」。
- 更长的脚本应拆成多个 Job，或先用 `files write` 落到目标机再 `powershell -File` 执行。
- 读取这类主机状态时**避免 `reg query ... /s` 递归**大子树（实测会挂住直到 Job 超时）。

## 11. 相关文档

[`ADR-0028`](../adr/0028-windows-desktop-capture-engine-in-session-vnc.md)、[`operations.md`](../operations.md) §9、[`design/p2p-tunnel.md`](./p2p-tunnel.md)、[`security.md`](../security.md)、[`deployment.md`](../deployment.md)。
