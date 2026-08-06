# 多盘容量与占用率上报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** client 上报所有磁盘（Windows 盘符 / Linux 白名单挂载点）的容量与使用率，机器概览以多盘列表展示。

**Architecture:** 协议新增 `DiskInfo[]` 进 Heartbeat（容量+使用率一体），删除 `totalDiskMB`/`diskPercent` 单盘字段；client 新增纯函数采集模块 `disks.ts`（mountinfo 解析/去重/白名单）；server 存 JSON 列透传；前端 Overview 磁盘卡改为逐盘进度条列表。

**Tech Stack:** TypeScript（ESM + NodeNext）、NestJS + Prisma/SQLite、React + Vite、vitest。

## Global Constraints

- 无老客户端兼容包袱（项目从未上线），协议字段直接增删，不留兼容分支
- Linux 采集：fstype 白名单（`ext2 ext3 ext4 xfs btrfs f2fs bcachefs jfs reiserfs zfs ntfs ntfs3 vfat exfat hfsplus overlay`），按 `major:minor` 去重；网络文件系统（nfs/cifs/fuse.*）与伪文件系统（proc/sysfs/tmpfs/squashfs/cgroup 等）一律不报
- 容量口径：`totalMB = bytes ÷ 1024²`（MiB，与 `totalMemMB` 一致）；`usedPercent = min(round((total-free)/total×100), 100)`
- 前端容量展示沿用已修复的 GiB 口径 `fmt`（÷1024）
- 注释与提交信息使用简体中文；公共 surface 写中文 JSDoc
- 设计基准：`docs/superpowers/specs/2026-08-07-multi-disk-reporting-design.md`

---

### Task 1: shared 协议类型

**Files:**

- Modify: `packages/shared/src/index.ts`（`MachineRegister` ~L52、`Heartbeat` ~L59、`ClientInfo` ~L185）

**Interfaces:**

- Produces: `export interface DiskInfo { name: string; totalMB: number; usedPercent: number }`；`Heartbeat.disks: DiskInfo[]`；`ClientInfo.disks: DiskInfo[]`；`MachineRegister` 与 `ClientInfo` 删除 `totalDiskMB`，`Heartbeat`/`ClientInfo` 删除 `diskPercent`

- [ ] **Step 1: 修改类型定义**

在 `Heartbeat` 前新增：

```ts
/** 单盘容量与占用率（容量与使用率来自同一次 statfs） */
export interface DiskInfo {
 name: string; // Windows: "C:" / "D:"；Linux: 挂载点 "/"、"/home"
 totalMB: number; // MiB（bytes ÷ 1024²，与 totalMemMB 同口径）
 usedPercent: number; // 0-100
}
```

- `MachineRegister`：删除 `totalDiskMB: number;` 行
- `Heartbeat`：删除 `diskPercent: number;`，改为 `disks: DiskInfo[];`
- `ClientInfo`：删除 `totalDiskMB: number;` 与 `diskPercent: number | null;`，改为 `disks: DiskInfo[];`

- [ ] **Step 2: 编译验证**

Run: `pnpm --filter @vcpdeck/shared build`
Expected: `tsc` 通过（此时其他包会有类型错误，属预期，Task 2-5 逐个消化）

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): 新增 DiskInfo 类型，磁盘字段改为 disks 数组"
```

---

### Task 2: client 多盘采集

**Files:**

- Create: `packages/client/src/disks.ts`
- Create: `packages/client/src/disks.test.ts`
- Modify: `packages/client/src/heartbeat.ts`
- Modify: `packages/client/src/register.ts`

**Interfaces:**

- Produces: `collectDisks(): DiskInfo[]`（供 `getHeartbeat` 使用）、`parseMountInfo(content: string): MountRow[]`、`pickDisks(rows: MountRow[]): MountRow[]`（后两者为纯函数，供测试）、`export interface MountRow { majorMinor: string; mountpoint: string; fstype: string }`
- Consumes: `DiskInfo` from `@vcpdeck/shared`

- [ ] **Step 1: 写失败测试**

Create `packages/client/src/disks.test.ts`：

```ts
import { expect, it } from "vitest";
import { parseMountInfo, pickDisks } from "./disks.js";

const FIXTURE = [
 "23 19 0:21 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
 "24 19 0:22 / /sys rw,nosuid,nodev,noexec,relatime - sysfs sysfs rw",
 "26 19 0:1 / /dev rw,nosuid,relatime - devtmpfs devtmpfs rw",
 "31 25 0:23 / /run rw,nosuid,nodev,relatime - tmpfs tmpfs rw",
 "36 19 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
 "38 36 8:1 /home /home rw,relatime - ext4 /dev/sda1 rw",
 "40 19 8:2 / /data rw,relatime - xfs /dev/sda2 rw",
 "45 19 0:24 / /var/lib/snapd/snaps/x1.snap ro,nodev,relatime - squashfs /dev/loop0 ro",
 "50 19 0:30 / /mnt/nas rw,relatime - nfs4 10.0.0.5:/share rw",
 "53 19 0:31 / /var/lib/docker/overlay2/abc rw,relatime - overlay overlay rw",
 "60 19 0:32 / /mnt/My\\040Disk rw,relatime - ext4 /dev/sdb1 rw",
].join("\n");

it("解析 mountinfo 文本，解码八进制转义", () => {
 const rows = parseMountInfo(FIXTURE);
 expect(rows).toHaveLength(11);
 expect(rows[4]).toEqual({ majorMinor: "8:1", mountpoint: "/", fstype: "ext4" });
 expect(rows[10]).toEqual({
  majorMinor: "0:32",
  mountpoint: "/mnt/My Disk",
  fstype: "ext4",
 });
});

it("跳过不含分隔符的行", () => {
 expect(parseMountInfo("no separator here\n")).toEqual([]);
});

it("白名单过滤并按键去重：保留根挂载，丢弃 bind、伪文件系统与网络文件系统", () => {
 const picked = pickDisks(parseMountInfo(FIXTURE));
 expect(picked.map((m) => m.mountpoint)).toEqual([
  "/",
  "/data",
  "/var/lib/docker/overlay2/abc",
  "/mnt/My Disk",
 ]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @vcpdeck/client test -- src/disks.test.ts`
Expected: FAIL，模块 `./disks.js` 不存在

- [ ] **Step 3: 实现 disks.ts**

Create `packages/client/src/disks.ts`：

```ts
import * as fs from "node:fs";
import type { DiskInfo } from "@vcpdeck/shared";

export interface MountRow {
 majorMinor: string;
 mountpoint: string;
 fstype: string;
}

/** 本地块设备文件系统白名单；overlay 覆盖容器内根文件系统。
 *  ponytail: 网络文件系统（nfs/cifs 等）不报，挂死的 NFS 会卡死 statfs；需要时改为带超时探测 */
const ALLOWED_FSTYPES = new Set([
 "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "bcachefs", "jfs",
 "reiserfs", "zfs", "ntfs", "ntfs3", "vfat", "exfat", "hfsplus", "overlay",
]);

/** 解析 /proc/self/mountinfo 文本；挂载点含 \040 等八进制转义，需解码 */
export function parseMountInfo(content: string): MountRow[] {
 const rows: MountRow[] = [];
 for (const line of content.split("\n")) {
  const sep = line.indexOf(" - ");
  if (sep < 0) continue;
  const head = line.slice(0, sep).split(" ");
  const tail = line.slice(sep + 3).split(" ");
  if (head.length < 5 || tail.length < 1) continue;
  rows.push({
   majorMinor: head[2],
   mountpoint: unescapeOctal(head[4]),
   fstype: tail[0],
  });
 }
 return rows;
}

function unescapeOctal(value: string): string {
 return value.replace(/\\([0-7]{3})/g, (_, oct: string) =>
  String.fromCharCode(parseInt(oct, 8)),
 );
}

/** 白名单过滤 + 按 major:minor 去重（bind mount 只保留第一个；mountinfo 父挂载在前） */
export function pickDisks(rows: MountRow[]): MountRow[] {
 const seen = new Set<string>();
 const picked: MountRow[] = [];
 for (const row of rows) {
  if (!ALLOWED_FSTYPES.has(row.fstype)) continue;
  if (seen.has(row.majorMinor)) continue;
  seen.add(row.majorMinor);
  picked.push(row);
 }
 return picked;
}

function statfsDisk(path: string, name: string): DiskInfo | null {
 try {
  const s = fs.statfsSync(path);
  const total = Number(BigInt(s.blocks) * BigInt(s.bsize));
  const free = Number(BigInt(s.bavail) * BigInt(s.bsize));
  if (total === 0) return null;
  return {
   name,
   totalMB: Math.round(total / 1024 / 1024),
   usedPercent: Math.min(Math.round(((total - free) / total) * 100), 100),
  };
 } catch {
  return null; // 无介质 / 未连接 / 无权限的盘跳过
 }
}

function collectWindowsDisks(): DiskInfo[] {
 const disks: DiskInfo[] = [];
 for (let i = 0; i < 26; i++) {
  const name = `${String.fromCharCode(65 + i)}:`; // A: - Z:
  const disk = statfsDisk(`${name}\\`, name);
  if (disk) disks.push(disk);
 }
 return disks;
}

function collectLinuxDisks(): DiskInfo[] {
 try {
  const content = fs.readFileSync("/proc/self/mountinfo", "utf-8");
  return pickDisks(parseMountInfo(content))
   .map((m) => statfsDisk(m.mountpoint, m.mountpoint))
   .filter((d): d is DiskInfo => d !== null);
 } catch {
  return [];
 }
}

/** 所有盘：Windows 遍历盘符；Linux 白名单挂载点；其他平台退化为根分区 */
export function collectDisks(): DiskInfo[] {
 if (process.platform === "win32") return collectWindowsDisks();
 if (process.platform === "linux") return collectLinuxDisks();
 const root = statfsDisk("/", "/");
 return root ? [root] : [];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @vcpdeck/client test -- src/disks.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 接入 heartbeat.ts**

删除 `calcDiskPercent` 函数与 `fs` import；`getHeartbeat` 返回对象改为：

```ts
return {
 clientId: CLIENT_ID,
 cpuPercent: Math.min(calcCpuPercent(), 100),
 memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
 disks: collectDisks(),
 runningJobs,
 uptime: Math.round(process.uptime()),
};
```

顶部 import 改为：`import { collectDisks } from "./disks.js";`

- [ ] **Step 6: 精简 register.ts**

删除 `totalDiskMB: Math.round(diskTotalMB()),` 行与整个 `diskTotalMB` 函数（`fs` import 保留，`loadOrCreateClientId` 仍在使用）

- [ ] **Step 7: 编译 + 全量 client 测试**

Run: `pnpm --filter @vcpdeck/client build && pnpm --filter @vcpdeck/client test`
Expected: `tsc` 通过（若提示未使用 import 则清理），vitest 全绿

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/disks.ts packages/client/src/disks.test.ts packages/client/src/heartbeat.ts packages/client/src/register.ts
git commit -m "feat(client): 多盘采集（Windows 盘符 / Linux 白名单挂载点）"
```

---

### Task 3: server schema 与服务

**Files:**

- Modify: `packages/server/prisma/schema.prisma`（Client 模型）
- Modify: `packages/server/src/client/client.service.ts`

**Interfaces:**

- Consumes: `MachineRegister`（无 `totalDiskMB`）、`Heartbeat.disks: DiskInfo[]`、`DiskInfo` from `@vcpdeck/shared`
- Produces: `Client.disks String @default("[]")`；`ClientInfo.disks: DiskInfo[]`

- [ ] **Step 1: 修改 schema**

`packages/server/prisma/schema.prisma` Client 模型：

- 删除 `totalDiskMB     Int` 行
- 删除 `diskPercent     Float?` 行
- 在 `capabilities` 行后新增 `disks          String    @default("[]")`

- [ ] **Step 2: 重新生成 Prisma client**

Run: `cd packages/server && npx prisma generate`
Expected: 生成器输出成功（`packages/server/generated/` 已 gitignore，仅本地生成）

- [ ] **Step 3: 修改 client.service.ts**

- import 增加 `DiskInfo`：`import type { MachineRegister, Heartbeat, ClientInfo, DiskInfo } from "@vcpdeck/shared";`
- `register()` 的 create 与 update 对象中各删除一行 `totalDiskMB: dto.totalDiskMB,`
- `heartbeat()` 的 data 中 `diskPercent: dto.diskPercent,` 改为 `disks: JSON.stringify(dto.disks),`
- `listOnline()` 的 map 返回中删除 `totalDiskMB: c.totalDiskMB,` 与 `diskPercent: c.diskPercent ?? null,`，在 `capabilities` 解析块后新增：

```ts
let disks: DiskInfo[] = [];
try {
 disks = JSON.parse(c.disks) as DiskInfo[];
} catch {
 // ponytail: stored as JSON, fallback to empty on corruption
}
```

并在返回对象中加 `disks,`

- [ ] **Step 4: 编译验证**

Run: `pnpm --filter @vcpdeck/server build`
Expected: `tsc` 通过，无残留 `totalDiskMB`/`diskPercent` 引用（`rg -n "totalDiskMB|diskPercent" packages/server/src` 应只剩本文件的 `disks` 相关或为空）

- [ ] **Step 5: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/src/client/client.service.ts
git commit -m "feat(server): Client 存储 disks JSON，透传多盘数据"
```

---

### Task 4: e2e 脚本 fixtures

**Files:**

- Modify: `scripts/test.cjs`（~L781、~L1505、~L1734 三处）

- [ ] **Step 1: 更新注册 fixture**

两处 `Events.REGISTER` 的 payload（分别位于 `test-no-file` 与 `test-integration-` 场景）各删除一行 `totalDiskMB: 10240,`

- [ ] **Step 2: 更新心跳 fixture**

`Events.HEARTBEAT` 的 payload 中 `diskPercent: 40,` 改为 `disks: [],`

- [ ] **Step 3: 语法检查**

Run: `node --check scripts/test.cjs`
Expected: 无输出（通过）

- [ ] **Step 4: Commit**

```bash
git add scripts/test.cjs
git commit -m "chore(test): e2e fixtures 适配多盘协议"
```

---

### Task 5: 前端多盘渲染

**Files:**

- Modify: `packages/frontend/src/pages/machine-workspace.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.test.tsx`
- Modify: `packages/frontend/src/pages/machines-page.test.tsx`
- Modify: `packages/frontend/src/pages/frp-page.test.tsx`
- Modify: `packages/sdk/src/domains.test.ts`

**Interfaces:**

- Consumes: `ClientInfo.disks: DiskInfo[]`；新增组件 `DiskCard({ disks }: { disks: DiskInfo[] })`
- Produces: 概览页磁盘卡：每盘一行（name + 容量 + 使用率进度条）；`disks` 为空 → "—" 占位

- [ ] **Step 1: 更新 SDK 测试 fixture**

`packages/sdk/src/domains.test.ts` `clients.list returns full machine info` 用例：

- serverResponse 中删除 `totalDiskMB: 512000,` 与 `diskPercent: 67.8,`，新增 `disks: [{ name: "C:", totalMB: 512000, usedPercent: 67.8 }],`
- 断言删除 `expect(c.totalDiskMB).toBe(512000);` 与 `expect(c.diskPercent).toBe(67.8);`，新增 `expect(c.disks).toEqual([{ name: "C:", totalMB: 512000, usedPercent: 67.8 }]);`

Run: `pnpm --filter @vcpdeck/sdk test` → 预期 PASS

- [ ] **Step 2: 更新前端测试 fixtures（machines-page / frp-page）**

- `packages/frontend/src/pages/machines-page.test.tsx`：两处 client 字面量各删除 `totalDiskMB: ...` 与 `diskPercent: null,`，新增 `disks: [],`
- `packages/frontend/src/pages/frp-page.test.tsx` `clientInfo()`：删除 `totalDiskMB: 1,` 与 `diskPercent: null,`，新增 `disks: [],`

Run: `cd packages/frontend && npx vitest run src/pages/machines-page.test.tsx src/pages/frp-page.test.tsx` → 预期 PASS

- [ ] **Step 3: 更新 machine-workspace 测试（先红）**

`packages/frontend/src/pages/machine-workspace.test.tsx`：

- "renders full machine info" 用例 fixture：删除 `totalDiskMB: 512000,` 与 `diskPercent: 92.8,`，新增：

```ts
disks: [
 { name: "C:", totalMB: 512000, usedPercent: 92.8 },
 { name: "D:", totalMB: 464444, usedPercent: 5 },
],
```

断言删除 `expect(screen.getByText("512 GB")).toBeVisible();` 与 `expect(screen.getByRole("progressbar", { name: "磁盘使用率" })).toHaveClass("bg-red-500");`，新增：

```ts
expect(screen.getByText("C:")).toBeVisible();
expect(screen.getByText("D:")).toBeVisible();
expect(screen.getByText("500 GB")).toBeVisible();
expect(screen.getByText("454 GB")).toBeVisible();
expect(screen.getByText("92.8%")).toBeVisible();
expect(screen.getByText("5.0%")).toBeVisible();
expect(
 screen.getByRole("progressbar", { name: "磁盘 C: 使用率" }),
).toHaveClass("bg-red-500");
expect(
 screen.getByRole("progressbar", { name: "磁盘 D: 使用率" }),
).toHaveClass("bg-primary");
```

- "shows — for missing heartbeat fields" 用例：fixture 删除 `totalDiskMB: 1_000_000,` 与 `diskPercent: null,`，新增 `disks: [],`；断言 `getAllByRole("progressbar")` 长度改为 2，`getAllByText("—")` 长度改为 3

Run: `cd packages/frontend && npx vitest run src/pages/machine-workspace.test.tsx`
Expected: FAIL（页面仍渲染旧的单盘卡）

- [ ] **Step 4: 实现 DiskCard（变绿）**

`packages/frontend/src/pages/machine-workspace.tsx`：

- import 增加 `DiskInfo`：`import type { ClientInfo, DiskInfo } from "@vcpdeck/shared";`
- Overview 中删除 磁盘 ResourceCard 一行，改为 `<DiskCard disks={client.disks} />`（CPU、内存卡与 `lg:grid-cols-3` 网格不变）
- 文件底部（ResourceCard 之后）新增：

```tsx
function DiskCard({ disks }: { disks: DiskInfo[] }) {
 return (
  <Card>
   <CardContent className="pt-6">
    <div className="flex items-start justify-between gap-4">
     <div>
      <p className="text-sm font-medium text-muted-foreground">磁盘</p>
      {disks.length === 0 && (
       <p className="mt-2 text-3xl font-semibold tabular-nums">—</p>
      )}
     </div>
     <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
      <HardDrive className="size-5" />
     </div>
    </div>
    {disks.length === 0 ? (
     <p className="mt-3 text-xs text-muted-foreground">尚无磁盘数据</p>
    ) : (
     <ul className="mt-5 space-y-4">
      {disks.map((disk) => {
       const bounded = Math.min(100, Math.max(0, disk.usedPercent));
       const color =
        bounded >= 90
         ? "bg-red-500"
         : bounded >= 70
          ? "bg-amber-500"
          : "bg-primary";
       return (
        <li key={disk.name}>
         <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{disk.name}</span>
          <span className="text-xs text-muted-foreground">
           {fmt(disk.totalMB)} · {disk.usedPercent.toFixed(1)}%
          </span>
         </div>
         <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
          <div
           role="progressbar"
           aria-label={`磁盘 ${disk.name} 使用率`}
           aria-valuemin={0}
           aria-valuemax={100}
           aria-valuenow={disk.usedPercent}
           className={`h-full rounded-full transition-[width] duration-300 ${color}`}
           style={{ width: `${bounded}%` }}
          />
         </div>
        </li>
       );
      })}
     </ul>
    )}
   </CardContent>
  </Card>
 );
}
```

- [ ] **Step 5: 全量前端 + SDK 测试**

Run: `cd packages/frontend && npx vitest run && cd ../../packages/sdk && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: 类型检查 + Commit**

Run: `cd packages/frontend && npx tsc --noEmit`
Expected: No errors found

```bash
git add packages/frontend/src/pages/machine-workspace.tsx packages/frontend/src/pages/machine-workspace.test.tsx packages/frontend/src/pages/machines-page.test.tsx packages/frontend/src/pages/frp-page.test.tsx packages/sdk/src/domains.test.ts
git commit -m "feat(frontend): 概览磁盘卡改为多盘列表展示"
```

---

### Task 6: 文档与全量验证

**Files:**

- Modify: `docs/server-client-interaction-design.md`（Heartbeat 协议块 ~L119-126）

- [ ] **Step 1: 更新交互设计文档**

Heartbeat 类型块改为：

```ts
interface Heartbeat {
  clientId: string;
  cpuPercent: number;
  memPercent: number;
  disks: DiskInfo[];      // 每盘 { name, totalMB, usedPercent }
  runningJobs: string[];  // jobId 列表（含 waiting_input 状态的会话）
  uptime: number;         // client 进程运行秒数
}
```

并全局检查该文件是否还有 `totalDiskMB`/`diskPercent` 残留引用（`rg -n "totalDiskMB|diskPercent" docs/server-client-interaction-design.md` 应为空）。

- [ ] **Step 2: 全量构建**

Run: `pnpm build`
Expected: shared / client / server / frontend 全部 `tsc` 通过

- [ ] **Step 3: 全量单元测试**

Run: `pnpm --filter @vcpdeck/client test && pnpm --filter @vcpdeck/server test && pnpm --filter @vcpdeck/sdk test`
Expected: 各包 vitest 全绿（server 如无测试文件则跳过）

- [ ] **Step 4: 端到端集成测试**

Run: `pnpm --filter @vcpdeck/client build && node scripts/test.cjs`
Expected: 测试报告全部 pass（含 "Heartbeat updates lastHeartbeatAt"；如需联网下载 frpc 且失败，记录并注明环境原因，不算实现失败）

- [ ] **Step 5: Commit**

```bash
git add docs/server-client-interaction-design.md
git commit -m "docs: 更新心跳协议说明为多盘上报"
```

---

## Self-Review 记录

- **Spec 覆盖**：协议（Task 1）✓；client 枚举策略含 Windows/Linux/其他平台退化（Task 2）✓；server schema + service（Task 3）✓；e2e fixtures（Task 4）✓；前端多盘列表 + 空态（Task 5）✓；文档（Task 6）✓
- **占位符**：无 TBD/TODO；所有步骤含完整代码或精确 diff 描述
- **类型一致性**：`DiskInfo`/`MountRow`/`parseMountInfo`/`pickDisks`/`collectDisks`/`DiskCard` 在定义与消费处签名一致；`disks` 字段在 shared → client → server → frontend 命名统一；`fmt` 沿用 Task 0（已提交的 GiB 修复）不动
