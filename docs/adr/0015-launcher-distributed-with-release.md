# ADR-0015：Launcher 随发布包分发但独立于业务版本运行

- 状态：Accepted
- 日期：2026-08-17
- 决策者：项目维护者
- 关联：[`ADR-0003`](./0003-separate-launcher-for-updates.md)、[`ADR-0012`](./0012-bundled-release-artifacts.md)、[`deployment.md`](../deployment.md)

## 背景

首次部署需要同时准备 Launcher、Server 或 Client。若发布 zip 只包含业务构件，安装后还必须由运维单独寻找和配置 Launcher，启动命令中的路径也无法自动确定。

同时，Launcher 负责业务进程的守护、更新和回退，不能随 `apps/<version>/` 的业务版本切换而被覆盖，否则 Windows 文件锁和 Launcher 自身更新会破坏稳定的生命周期边界。

## 决策

- 每个平台发布 zip 同时包含 `launcher/`、`server/` 和 `client/`；Launcher 入口由 esbuild 生成 `launcher/dist/main.js`；
- `manifest.json` 声明 `launcher.dir` 和 `launcher.entry`，安装脚本校验这两个字段及实际入口；
- `install.cjs` 首次安装时将 Launcher 入口复制到 `<app-dir>/dist/main.js`；Server 默认 `<app-dir>` 为 `~/.vcpdeck/launcher`，Client 默认为 `~/.vcpdeck/launcher-client`；已有入口默认保留，不因 `--force` 或业务版本安装而覆盖；
- Server/Client 仍安装到 `<app-dir>/apps/<version>/`，current 指针只选择业务版本；同机 Server/Client 默认使用不同 app-dir；
- 安装完成后启动命令固定为：
  `node --env-file="<app-dir>/launcher.env" "<app-dir>/dist/main.js"`；
- Launcher 不随业务版本自动更新。需要升级 Launcher 时，使用后续明确的 Launcher 升级流程，并先验证兼容性。

## 候选方案

- **要求用户提供 `--launcher-path`**：拒绝。首次安装不应依赖用户知道内部部署路径，且发布包已经可以携带 Launcher；
- **把 Launcher 放进 `apps/<version>/`**：拒绝。业务切换会覆盖或切换 Launcher，破坏独立生命周期；
- **发布包不含 Launcher，完全由运维准备**：拒绝。首次安装步骤不完整，无法可靠打印可复制的启动命令。

## 后果

正面：

- 一条安装命令即可准备 Launcher 与业务构件；
- Windows/Linux 使用一致的稳定 Launcher 路径；
- 业务版本切换不会替换正在运行的 Launcher；
- 自动更新继续只切换业务版本目录，保持 ADR-0003 的回退模型。

代价与限制：

- 每个平台 zip 增加一个 Launcher bundle；
- Launcher 升级暂不自动化，发布者必须单独处理 Launcher 兼容性；
- 旧版不含 `launcher` 字段的安装包不能被新的 `install.cjs` 作为首次安装包接受。

## 验证与退出条件

- 发布 zip 的两个平台变体均包含 `launcher/dist/main.js`；
- 新空 `app-dir` 安装后存在 `dist/main.js`、`launcher.env` 和业务版本目录；
- 已存在 `app-dir/dist/main.js` 时安装新业务版本不会改变其内容；
- 安装输出包含完整、可复制的 Launcher 启动命令；
- Server/Client 业务更新与 Launcher smoke 测试继续通过。
