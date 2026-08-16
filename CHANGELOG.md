# 更新日志

VCPDeck 尚未发布稳定版本。本文件记录用户或运维人员可感知的变化；内部重构若不改变行为可以不单列。

格式参考 Keep a Changelog，版本采用语义化版本。日期使用 `YYYY-MM-DD`。

## [Unreleased]

### Added

- 建立长期维护文档体系：架构、技术栈、领域模型、协议、兼容性、部署、运维、安全、测试、ADR、路线图和专题/归档索引。

### Changed

- 补充当前已落地的远程终端、远程 Pi、文件传输、FRP 和 Launcher 架构说明。

### Fixed

- 暂无。

### Security

- 明确 Client PSK 当前实际配置变量为 `VCPDECK_PSK`，示例中的 `VCPDECK_CLIENT_PSK` 尚未被代码读取。

### Migration

- 当前开发数据库和构件版本仍为 `0.0.0`，尚无稳定版本迁移承诺。

<!--
发布时：
1. 将 Unreleased 内容移动到 `## [x.y.z] - YYYY-MM-DD`；
2. 至少保留 Added / Changed / Fixed / Security / Deprecated / Removed / Migration 中适用的小节；
3. 在 Migration 写明数据库、配置、Launcher、协议和回滚限制；
4. 创建新的空 Unreleased。
-->
