# ADR-0010：脚本执行使用 Client 持有的受控运行时注册表

- 状态：Accepted
- 日期：2026-08-15
- 决策者：项目维护者
- 关联：[`docs/design/remote-execution.md`](../design/remote-execution.md)、[`docs/protocols.md`](../protocols.md)、[ADR-0004](./0004-typed-job-kernel.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)

## 背景

VCPDeck 的 `exec` Job 同时支持短 Shell command 和通过 stdin 发送源码的 script。stdin 能避开命令行长度与多层转义问题，但当前 script 协议允许 Browser/API 直接提交 `executable` 和 `args`，Server 持久化并透传，Client 使用 `spawn(executable, args, {shell:false})` 执行。

当前系统采用少量可信操作者单信任域，command 本身已经提供任意远程 Shell 能力，因此 arbitrary executable 并没有扩大当前可信操作者可达的最终权限。然而它仍造成长期协议和维护问题：

- Browser、SDK 和自动化调用方必须知道目标机器的可执行文件名称、路径和平台参数；
- Server 无法在派发前可靠判断解释器是否存在；
- executable 绝对路径容易进入 Job payload、页面和备份；
- 固定 stdin 参数由各调用方重复拼装，容易出现不兼容或不安全差异；
- 后续增加非完全可信身份时，任意 executable 会扩大授权和审计复杂度；
- Client 已经在 Terminal 中采用“公开 shellId、内部映射 executable/args”的成熟边界，脚本运行时应保持类似职责归属。

当前实现尚未落实运行时注册表、runtime capability 和双端严格 parser。本 ADR 记录长期目标，不把未完成迁移描述为当前能力；迁移期间的实际事实以 `docs/design/remote-execution.md` 和代码为准。

## 决策

1. `exec` 保留互斥的 `command` 和 `script` 模式。
2. command 模式继续作为可信操作者的一次性系统 Shell 入口；它不是 allowlist 或沙箱。
3. script 的长期外部协议只接受：
   - `runtime`：受控运行时 ID；
   - `script`：UTF-8 源码；
   - 经约束的 cwd 引用或兼容期 cwd；
   - Job 顶层 timeout。
4. Browser、SDK、CLI 和 REST 不得在目标协议中提交 executable、解释器 args 或 shell 开关。
5. Client 持有 `runtime ID → executable + 固定 args` 的内存注册表，负责平台探测、配置、绝对路径解析和 stdin 参数。
6. Client 只为实际可用的运行时声明 `exec.script.<runtime>` capability；Server 创建 Job 前必须校验 `exec` 和对应 runtime capability。
7. runtime ID 使用稳定、小写、与路径无关的标识。未知或不可用 runtime 返回稳定错误，不自动改用 command、系统 Shell或其他解释器。
8. Shared 定义 command/script 判别联合、严格运行时 parser、runtime ID 和大小边界；Server 与 Client 都必须在跨信任边界验证。
9. runtime registry 只是解释器选择约束，不是代码沙箱。脚本仍继承 Client OS 运行账户权限，可以访问该账户可访问的文件、网络、环境变量和子进程。
10. 旧 `executable + args` payload 必须通过显式兼容窗口迁移，不能永久与 runtime 协议并存，也不能由 Server 静默转换成 Shell command。
11. 迁移同时补齐：script/output 大小限制、cwd root/canonical 校验、稳定 timeout 终态、跨平台进程树取消和敏感数据保留策略。
12. 在上述双端迁移完成并通过兼容测试前，当前 arbitrary executable 实现仍是运行事实，但不得继续扩展为新的公共能力。

首批运行时目标：

| Runtime ID | Client 内部固定行为 |
| --- | --- |
| `node` | 使用 `process.execPath`，从 stdin 执行 |
| `python` | 使用受控 Python 路径和 unbuffered stdin 参数 |
| `powershell` | 使用认可的 PowerShell，禁用 profile 和交互提示，从 stdin 执行 |
| `bash` | 使用认可的 Bash，以固定 stdin 参数执行 |

具体参数、探测优先级和配置方式属于专题设计和兼容协议；不得通过修改 ADR 追逐局部实现。

## 候选方案

### 保留调用方提交 arbitrary executable 和 args

与当前可信操作者模型一致，灵活且无需 Client 探测。但它把平台知识和解释器路径暴露到 Browser/API，无法稳定表达运行时能力，增加协议、审计、自动化和未来授权成本，因此不作为长期公共协议。

### 所有脚本拼成 command 字符串

实现最简单，但重新引入 argv 长度、多层引号、反斜杠和 Shell 注入/平台差异；也无法可靠判断源码是否完整送达，因此不采用。

### 为每种语言新增独立 Job 类型

可以获得强类型字段，但会复制调度、事件、输出、取消和状态逻辑。语言解释器差异可以由 runtime ID 和 Client registry 表达，不需要 `node.script`、`python.script` 等 Job 类型，因此不采用。

### 立即引入容器或沙箱

安全隔离更强，但当前目标机器、Windows/Linux 支持、文件访问和运维成本尚未形成明确要求。runtime registry 不能替代沙箱；如果未来需要不可信代码执行，应创建独立 ADR 评估容器、低权限账户、网络/文件隔离和资源限制。

### 大脚本统一写临时文件

可以提供真实文件名和模块目录，但增加文件生命周期、清理、扩展名和安全问题。首批小脚本使用 stdin；需要 Artifact、相对 import 或超出消息上限时，再设计 FileRef/Script Artifact 模型。

## 后果

### 正面

- 调用方只依赖稳定 runtime ID，不需要知道目标机器路径和平台参数；
- executable 和固定参数留在 Client，不进入普通外部协议；
- Server 可以在创建阶段根据 capability 明确拒绝；
- 每种解释器的 stdin 约束集中维护和测试；
- Frontend、SDK、CLI 和 AI 自动化更容易生成跨平台请求；
- 为未来细粒度授权和审计减少一类任意参数面。

### 负面

- Shared、Server、Client、Frontend、SDK 和 CLI 需要协调迁移；
- Client 启动探测和配置更复杂；
- 同一语言的版本、虚拟环境和项目运行时需要稳定 ID 策略；
- 兼容窗口内需要同时识别旧 Client/调用方并明确拒绝不安全组合；
- runtime 可用性会随目标机器环境变化，注册和重连必须重新上报；
- command 模式仍提供任意 Shell 权限，整体系统并未因此成为沙箱。

### 安全与数据影响

- script、cwd 和最终 stdout/stderr 仍可能进入 SQLite 与备份，必须有大小、访问和保留限制；
- runtime capability 是机器能力，不是用户授权；
- 使用低权限 Client OS 账户仍是主要权限边界；
- 错误和 capabilityDetails 不得泄露 executable 绝对路径、PATH 或环境变量；
- 取消必须覆盖解释器创建的进程树，不能只杀直接子进程。

### 兼容与迁移影响

这是 script payload 的破坏性变化。实施时必须：

1. 定义协议/能力区分，使新 Server 不向旧 Client 下发 runtime payload；
2. 先部署能上报 runtime capability 的 Client；
3. 再切换 Frontend/SDK/CLI 到 runtime；
4. 对旧 executable payload 设置明确、有限的兼容窗口；
5. 在 CHANGELOG 和 compatibility 中记录拒绝条件；
6. 最终从 Shared、Server 和 Client 删除 arbitrary executable 字段。

不得仅凭同一个应用版本号猜测能力；以 capability 和必要的协议版本为准。

## 验证与退出条件

实现完成必须验证：

- runtime registry 与 capability 完全一致；
- 未注册 runtime 在创建阶段和 Client 边界均被拒绝；
- executable 路径不出现在 REST、Socket DTO、Job payload、capabilityDetails、错误和普通日志；
- Node/Python/PowerShell/Bash 在 Windows/Linux 的 stdin 行为符合定义；
- command 旧模式不回归；
- script/output/cwd 边界和进程树取消生效；
- 新旧 Server/Client/Frontend 组合得到明确兼容或明确拒绝；
- 完成迁移后 `docs/design/remote-execution.md` 不再把 arbitrary executable 列为当前事实。

出现以下情况时应创建新 ADR supersede 或扩展本决策：

- 需要执行非完全可信代码；
- 需要容器/沙箱或每运行时独立身份；
- 需要持久 Script Artifact、签名、审批和复用；
- runtime ID 无法表达项目虚拟环境或可重复构建要求；
- command 模式需要被移除或改为 allowlist。
