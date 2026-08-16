# 参与 VCPDeck 开发

> 维护责任：项目维护者｜最后核验：2026-08-15

## 1. 开始之前

先阅读：

- 根目录 `AGENTS.md` — 项目强制规范；
- [`docs/index.md`](./docs/index.md) — 文档入口；
- [`docs/documentation-governance.md`](./docs/documentation-governance.md) — 文档分类、生命周期与收敛规则；
- [`docs/architecture.md`](./docs/architecture.md) — 架构边界；
- [`docs/domain-model.md`](./docs/domain-model.md) — 状态和不变量；
- [`docs/protocols.md`](./docs/protocols.md) — 通信协议；
- [`docs/security.md`](./docs/security.md) — 高权限远程执行安全要求。

## 2. 本地环境

```bash
pnpm install
pnpm build
pnpm -r test
```

开发：

```bash
pnpm dev       # Server + Frontend
pnpm dev:all   # 额外启动 Client
```

Server 首次启动前复制 `packages/server/.env.example` 并设置管理员密码。注意当前实现读取 `VCPDECK_PSK`，不是示例中的 `VCPDECK_CLIENT_PSK`。

## 3. 变更原则

- 只实现当前需求，不提前增加空接口、factory、配置层或目录；
- 共享协议放 `packages/shared`，业务实现不放 Shared；
- Server、Client、Frontend 不跨包引用对方源码；
- TypeScript strict、ESM + NodeNext，相对导入保留 `.js`；
- 标识符、协议字段、数据库字段和枚举值使用英文；
- 业务/设计文档和注释使用简体中文；
- 导出的类型、函数和类写简体中文 JSDoc；
- 优先复用 Node 标准库和现有模块。

## 4. 开发流程

1. 明确需求、范围和验收条件；
2. 用 GitNexus 查询相关流程并对待改符号执行 upstream impact；
3. HIGH/CRITICAL 风险先告知并制定验证计划；
4. 读取现有代码、测试、架构/领域/协议/专题文档；
5. 先补失败测试，再做最小实现；
6. 运行受影响包测试、诊断、lint 和 build；
7. 更新 Current 文档、ADR/专题设计和 CHANGELOG；
8. 提交前运行 `gitnexus_detect_changes()`，确认影响范围符合预期；
9. 提交信息使用简体中文。

## 5. 协议变更

修改 REST、Socket.IO、SSE、Job、Terminal、Pi、Release 或 Launcher 协议时：

- 先更新 Shared 类型、事件名、错误码和 parse 函数；
- 判断是否兼容，必要时增加协议版本；
- 同步 Server、Client、SDK、Frontend；
- 测试未知字段、旧版本、断线、重试和迟到事件；
- 更新 `docs/protocols.md`、`docs/compatibility.md`；
- 破坏性变化必须有 ADR、迁移说明和 CHANGELOG。

## 6. 数据库变更

- 修改 `packages/server/prisma/schema.prisma`；
- 提供可审查 migration 和数据回填策略；
- 为升级前后数据增加测试；
- 评估 Launcher 应用回退是否仍能读取新 schema；
- 生产方案不得以 `db push --accept-data-loss` 代替迁移；
- 更新领域模型、部署、运维和兼容文档。

## 7. 安全要求

- 所有边界输入都必须校验；
- 错误对象保持稳定 `code`、正确 `statusCode` 和安全 message；
- 不记录 stack、密钥、签名 URL、命令正文、路径/文件内容、终端/Pi 正文；
- 不把 Frontend 检查当作授权；
- Job、PTY、Pi、文件和 FRP 测试不得执行真实破坏性操作；
- 新依赖需要说明必要性、许可证、维护状态和供应链风险。

## 8. 测试要求

最低要求：

```bash
pnpm -r test
pnpm lint
pnpm build
pnpm test
```

FRP、Terminal、Pi、Release 等按 [`docs/testing.md`](./docs/testing.md) 增加专项测试。测试跳过不能视为通过。

## 9. 文档与 ADR

完整规则见 [`docs/documentation-governance.md`](./docs/documentation-governance.md)。每次变更至少执行：

- 当前系统事实：更新 README/architecture/domain/protocols 等对应 Current 文档；
- 重大长期取舍：新增 ADR；改变既有决策时用新 ADR supersede，不能改写历史结论；
- 复杂且需持续维护的功能设计：更新 `docs/design/` 对应专题；
- 未来规划：只写入 `docs/roadmap.md` 或 Issue；
- 用户或运维可感知变化：更新 `CHANGELOG.md` 的 Unreleased；
- 过程材料：有效知识收敛后删除；只有确有历史价值的失效材料才归档；
- 发现代码、ADR 和 Current 文档冲突时必须报告并确认，不能静默选择其中一方。

## 10. PR 检查项

- [ ] 改动范围和风险清晰；
- [ ] 影响分析已执行；
- [ ] 测试覆盖成功、失败、取消、断线/重连；
- [ ] 无敏感信息泄露；
- [ ] 协议/数据库兼容已说明；
- [ ] Current 文档、ADR 和 CHANGELOG 已按需更新；
- [ ] 未完成事项只进入 Roadmap 或 Issue；
- [ ] 无长期价值的过程材料已删除，有历史价值的失效材料已归档；
- [ ] 文档链接、状态和事实一致性已检查；
- [ ] 诊断、lint、build、测试通过；
- [ ] detect_changes 只显示预期影响；
- [ ] 不包含生成物、临时数据库、日志或真实凭据。
