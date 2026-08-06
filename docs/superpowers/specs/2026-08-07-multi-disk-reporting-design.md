# 多盘容量与占用率上报设计

日期：2026-08-07

## 背景与目标

机器概览的"磁盘"卡只统计 client 进程 cwd 所在盘（原设计刻意简化为"检查根分区"），且容量换算存在混合单位问题（已单独修复为 GiB 口径）。用户测试机有 C:、D: 两个盘，期望**真实反映所有盘符（Windows）/ 所有挂载点（Linux）的容量与占用率**。

约束：

- 无老客户端兼容包袱（项目从未上线），协议可直接增删字段
- Linux 需兼容：不崩溃、不阻塞（挂死的 NFS 不能卡死心跳）、不展示伪文件系统
- UI 形式：机器概览卡片内展开为多盘列表（用户已确认，不做独立页签）

## 协议（`packages/shared/src/index.ts`）

```ts
/** 单盘容量与占用率（容量与使用率来自同一次 statfs） */
export interface DiskInfo {
  name: string;        // Windows: "C:" / "D:"；Linux: 挂载点 "/"、"/home"
  totalMB: number;     // MiB（bytes ÷ 1024²，与 totalMemMB 同口径）
  usedPercent: number; // 0-100
}
```

| 类型 | 变更 |
|------|------|
| `MachineRegister` | 删除 `totalDiskMB` |
| `Heartbeat` | 删除 `diskPercent`，新增 `disks: DiskInfo[]` |
| `ClientInfo` | 删除 `totalDiskMB`、`diskPercent`，新增 `disks: DiskInfo[]`（首心跳前为 `[]`） |

容量与使用率合并在同一个数组元素内，服务端无需跨消息合并。

## Client 枚举策略（`packages/client/src/heartbeat.ts`）

新增纯函数 `collectDisks(): DiskInfo[]`，按平台分派：

### Windows（win32）

遍历 `A:`–`Z:` 逐个 `statfsSync`，失败（无介质、未连接）跳过；映射网络盘由系统本地解析不阻塞。上限 26 次轻量系统调用，无额外依赖。

### Linux

解析 `/proc/self/mountinfo`：

- 按 `major:minor` 去重（bind mount 同一设备多处挂载只保留第一个；mountinfo 父挂载在前，天然保留根挂载点）
- fstype **白名单**过滤：
  - 包含：`ext2` `ext3` `ext4` `xfs` `btrfs` `f2fs` `bcachefs` `jfs` `reiserfs` `zfs` `ntfs` `ntfs3` `vfat` `exfat` `hfsplus` `overlay`
  - 排除：伪文件系统（`proc` `sysfs` `tmpfs` `devpts` `cgroup*` `squashfs` `ramfs` `mqueue` 等）与网络文件系统（`nfs*` `cifs` `smb3` `fuse.*` 等）
  - 白名单而非黑名单：新出现的伪文件系统类型不会漏网；网络文件系统被排除避免 statfs 挂死阻塞心跳（`ponytail:` 注释注明天花板与升级路径）
  - `overlay` 入选：容器内根文件系统为 overlay，statfs 返回宿主真实可用空间，避免容器场景空白
- 对入选挂载点逐个 `statfsSync` 取 total/used

### 其他平台（darwin 等）

退化为单盘 `statfs("/")`，`name="/"`。

每个盘的 `usedPercent = round((total - free) / total × 100)`（沿用现有口径，上限 100），`totalMB` 沿用 `bytes ÷ 1024²`。

## Server

### schema（`packages/server/prisma/schema.prisma`）

`Client` 模型：删除 `totalDiskMB Int`、`diskPercent Float?`，新增 `disks String @default("[]")`（JSON 文本，与 `capabilities` 同模式）。开发库由启动脚本的 `prisma db push` 自动同步；`prisma/migrate.cjs` 为死代码（无引用），不动。

### 服务（`packages/server/src/client/client.service.ts`）

- `register()`：删除 `totalDiskMB` 读写
- `heartbeat()`：`disks: JSON.stringify(dto.disks)`
- `listOnline()`：解析 `disks` JSON，异常回退 `[]`（同 `capabilities` 模式）；返回 `disks: DiskInfo[]`

网关（`client.gateway.ts`）直接透传 dto，无字段校验层，不需要改动。

## 前端（`packages/frontend/src/pages/machine-workspace.tsx`）

Overview 的磁盘区改为"磁盘"卡片，内部每盘一行：

- `name`（"C:" / "/"）+ 容量 `fmt(totalMB)`（沿用已修复的 GiB 口径）+ 使用率进度条
- 进度条 `aria-label` 按盘区分，如"磁盘 C: 使用率"
- `disks` 为空数组（未到首心跳）→ 单行 "—" 占位，与 CPU/内存缺失值风格一致
- CPU、内存卡不变；`fmt` 继续服务内存与磁盘

## 测试

| 层 | 内容 |
|----|------|
| client | mountinfo 解析 / major:minor 去重 / 白名单过滤抽为纯函数（如 `parseMountInfo`），用 fixture 文本单测；Windows 盘符循环不做 IO 测试 |
| server | client.service 测试 fixtures 更新为 `disks` 字段 |
| sdk | `domains.test.ts` 的 `diskPercent` fixture 改为 `disks` |
| frontend | `machine-workspace.test.tsx`（多盘渲染 + 空数组占位）、`machines-page.test.tsx`、`frp-page.test.tsx` fixtures 更新 |

## 文档

- 更新 `docs/server-client-interaction-design.md` 中 `diskPercent` 相关行
- 本设计文档存档于 `docs/superpowers/specs/`
