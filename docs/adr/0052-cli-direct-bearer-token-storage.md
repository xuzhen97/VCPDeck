# ADR-0052：CLI 用户级环境配置允许直接存储 Bearer Token

- 状态：Accepted
- 日期：2026-10-15
- 决策者：项目维护者
- 关联：[ADR-0017](./0017-cli-multi-environment-configuration.md)、[ADR-0050](./0050-dsh-skill-cli-consumption.md)

## 背景

在 ADR-0017 中，为避免明文凭据落盘，CLI 环境注册表规定仅允许以 `tokenEnv` / `passwordEnv` 形式引用环境变量名，运行时从宿主环境变量读取真实秘密。

然而在实际日常开发以及 Agent（如 DeepSeek Harness、Pi 等通过 ADR-0050 消费 CLI）的自动化调用中，该约束带来了显著的运维阻力：
1. 操作者和 Agent 启动的子进程、后台任务或非登录 shell 往往没有继承或导出对应的凭据环境变量；
2. 导致执行 CLI 时频发“缺少凭据变量”报错，必须在每次启动环境中反复处理 `export` 或注入环境变量；
3. 用户级配置文件 `~/.vcpdeck/cli/config.json` 位于用户主目录下，且 CLI 已实现原子写入和 POSIX `0700` / `0600` 私有文件权限保护，本就具备单机单用户隔离的安全边界。

为降低开发与 Agent 工具调用阻力，维护者决定修订 ADR-0017 中对 Bearer Token 的间接引用限制，支持将 Bearer Token 直接存储在用户级配置中。

## 决策

1. **修订 ADR-0017 第 2 条**：用户级环境注册表（`~/.vcpdeck/cli/config.json`）中的 Bearer 认证结构废除 `tokenEnv`，改为直接存储 `token: string`。
2. **凭据装载直连化**：CLI 在解析 Bearer 环境时直接使用配置中的 `token`，不再访问或要求存在任何宿主环境变量。
3. **保持项目级绝对隔离**：项目级选择器 `.vcpdeck.json` 依然严格限制为 `{ version: 1, environment: string }`。绝不允许在项目级配置中定义 Server、Token 或任何凭据，防止随 Git 提交泄露秘密。
4. **终端与摘要输出默认脱敏**：CLI 执行 `env list`、`env show`、`env current` 以及各类带环境摘要输出的命令时，严禁原样打印完整 Token，统一采用脱敏展示（保留前缀如 `bearer (token: vcp_tok...****)`）。
5. **命令参数调整**：`vcpdeck env add <name> --server=<url> --token=<token>` 为标准添加命令；传入旧 `--token-env` 时返回明确错误提示迁移。
6. **文件权限与原子写入不降级**：继续维持 POSIX 平台下的 `0700` 目录与 `0600` 文件权限收紧，并使用临时文件 + rename 原子写入。

## 候选方案

- **继续强制仅通过环境变量传递（ADR-0017 现状）**：虽然避免了配置文件落盘 Token，但在多进程与 Agent 调度中体验极差，反复排查环境变量注入成本过高，否决。
- **双模式兼容（同时允许 `token` 与 `tokenEnv`）**：增加了配置契约分支和解析复杂度，且维护者确认无需保留环境变量间接引用的绕弯逻辑，采用彻底直接存储方案。
- **允许项目级 `.vcpdeck.json` 内嵌 Token**：会导致误提交 Git 仓库的严重供应链风险，坚决拒绝。

## 后果

### 正面
- 操作者与 Agent 配置一次 `~/.vcpdeck/cli/config.json` 后即可直接使用 CLI，不再受限于外部环境变量传递状态；
- CLI 与 Skill 调用流程显著简化，开箱即用体验提升；
- 保持了文件权限与控制台输出脱敏，在便利性与单机安全性之间取得合理平衡。

### 成本与约束
- 本机单用户若发生失陷（如不受控的同 UID 进程读取 `~/.vcpdeck/`），Token 可能被读取；需依赖 OS 账户隔离与文件系统权限保护；
- 既有使用 `--token-env` 的环境配置需要重新执行 `env add` 或手动将 JSON 中的 `tokenEnv` 更改为 `token`。

## 验证与退出条件

- `config.ts` 解析验证 `auth.token` 有效性，并拒绝未知字段与遗留 `tokenEnv`；
- `environment.ts` 解析不读取 `processEnv`，且摘要输出已脱敏；
- `env-command.ts` 支持 `--token` 参数，对 `--token-env` 友好报错；
- 单元测试与端到端命令验收通过；
- `SKILL.md` 与 CLI 架构设计文档同步更新。
