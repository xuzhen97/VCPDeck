# ADR-0014：Local Storage 相对 baseDir 锚定到版本目录外

- 状态：Accepted
- 日期：2026-08-17
- 决策者：项目维护者
- 关联：[`docs/deployment.md`](../deployment.md)、[`ADR-0013`](./0013-frontend-bundled-with-server.md)、[`ADR-0012`](./0012-bundled-release-artifacts.md)

## 背景

Launcher 按**版本目录**（`apps/<version>/server`）启动 Server 进程。`LocalStorageProvider` 构造时对 `baseDir` 执行 `resolve()`（相对 cwd），而默认 seed 值是相对路径 `./data/storage`——文件实际落在版本目录内。自更新切换版本后，新 Server 读不到旧版本的 storage 文件，已上传文件"漂移丢失"。与 `VCPDECK_RELEASES_DIR` 的同类问题（见 install 引导修复）一起暴露，Storage 侧因配置存于 DB（`StorageBackendConfig`）不能靠 install 引导解决，需要 Server 侧解析语义决策。

## 决策

### 1. 相对 baseDir 解析锚定

`LocalStorageProvider` 解析 baseDir 时：

- **绝对 baseDir**：原样使用；
- **相对 baseDir**：锚定到 `VCPDECK_APP_DIR`（版本目录外；Launcher/install 引导场景均会设置该变量）→ `<appDir>/<baseDir>`；
- 未设置 `VCPDECK_APP_DIR`（裸 node 快速验证，无自更新）→ 维持现状按 cwd 解析。

抽为纯函数 `resolveStorageBaseDir(raw, appDir?)` 便于测试。

### 2. 不迁移既有库

存量 DB 中相对 baseDir（如默认 `./data/storage`）**不自动改写**：语义变化后，新文件落在锚定位置，旧文件仍在原版本目录的相对位置——由运维按文档指引手工搬迁（移动目录 + 可选更新 `StorageBackendConfig`）。不自动迁移的理由：搬移大目录有风险，且无法区分"默认 seed"与"用户有意配置的相对路径"。

### 3. seed 保持相对值不变

`main.ts` 首次 seed 仍写 `{ baseDir: "./data/storage" }`：相对名经锚定后变为 `<appDir>/data/storage`，与 deployment 持久化清单语义一致（名字不敏感，位置由锚定决定）。

## 不做的事

- 不改 DB 内容、不提供自动数据迁移；
- 不引入新环境变量（复用已有的 `VCPDECK_APP_DIR`）；
- Alibaba storage 配置不受影响（不涉及本地路径解析）。

## 后果

**正面**：

- Launcher + install（launcher.env 含 `VCPDECK_APP_DIR`）部署下，Local Storage 自更新后不再漂移，与 `VCPDECK_RELEASES_DIR` 修复闭环；
- 裸跑/开发行为不变（无 app-dir 时仍按 cwd）；
- 无 DB 迁移、无新变量，改动面小。

**风险与代价**：

- 存量相对 baseDir 的部署需**一次性手工搬迁**旧文件到锚定位置，并核对 `StorageBackendConfig`（或改为绝对 baseDir）；
- `VCPDECK_APP_DIR` 缺失且 cwd 恰好曾是版本目录的混合场景（人工复制目录部署）仍存在歧义——不在支持范围，文档列为已知边界。
