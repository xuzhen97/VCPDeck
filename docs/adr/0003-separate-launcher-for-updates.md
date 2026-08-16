# ADR-0003：独立 Launcher 管理进程与更新

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/design/release-and-update.md`、`docs/compatibility.md`

## 背景

Server/Client 需要跨 Windows/Linux 更新自身。业务进程无法可靠替换正在使用的文件，也无法在自身启动失败后完成回退。

## 决策

在业务进程之外运行稳定 Launcher。Launcher 负责 Node 运行时、版本目录、进程守护、下载/校验/解压、current 切换、健康探测和失败回退；Server 负责编排全局 Release，Client 负责优雅停机配合。Launcher 当前冻结，不参与自动更新。

## 候选方案

- 业务进程原地自更新：Windows 文件锁和失败回退不可控；
- 只依赖 systemd/Windows Service：不能统一跨平台版本目录和回退；
- 容器编排：当前个人部署成本过高且未覆盖目标机器形态。

## 后果

正面：更新生命周期与业务解耦；可跨平台回退；Server/Client 使用同一模型。

负面：首次安装复杂；Launcher 协议本身成为长期兼容边界；数据库迁移无法随应用回退自动逆转；当前最低 Launcher 版本尚未强制。

## 验证与退出条件

必须持续运行正常更新、坏版本回退、Server 恢复编排和离线 Client 补更测试。若引入容器或 Launcher 自更新，以新 ADR 取代本决策。
