# FRP Management UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert FRP mapping and frps instance management from sparse cards into polished responsive management tables with hostname-aware Client display, compact menus, and wide grouped drawers.

**Architecture:** Keep the existing `FrpPage`, `FrpPanel`, and `FrpsInstancesPanel` boundaries. Add only two tiny UI helpers: a wide option on the existing `Drawer`, and a page-local FRP action menu component reused by mapping and instance rows. Fetch Client names once in `FrpPanel` as optional display enrichment; mapping data remains authoritative.

**Tech Stack:** React 18, TypeScript strict mode, Vite, Vitest, Testing Library, Tailwind CSS, `@vcpdeck/sdk`, `@vcpdeck/shared`.

## Global Constraints

- Do not change REST, SDK, shared types, or backend behavior.
- Do not add dependencies, table libraries, Dropdown libraries, global Toast, global Context, or generic data-table systems.
- Client display name is existing `ClientInfo.hostname`; no custom alias feature.
- Client name loading must not block mapping list rendering; on failure show “未知 Client” plus short client ID.
- Probe results stay component-local and are not persisted.
- Dangerous actions remain protected by `ConfirmTargetDialog`.
- Token and Dashboard password must never appear in tables, menus, probe details, or error output.
- Preserve existing user/uncommitted changes in target frontend files; use patch edits only after reading the exact current file content.
- Before editing any existing function/component, run GitNexus upstream impact analysis and warn before proceeding if risk is HIGH or CRITICAL.

## File Map

- Modify `packages/frontend/src/components/ui/drawer.tsx`: add optional `size?: "default" | "wide"` without changing default callers.
- Create `packages/frontend/src/pages/frp-action-menu.tsx`: small reusable menu for row actions, Escape close, outside-click close, and disabled menu items.
- Modify `packages/frontend/src/pages/frp-panel.tsx`: load Client hostnames, render responsive mapping table/cards, copy public URL, use action menu, and wide grouped create Drawer.
- Modify `packages/frontend/src/pages/frps-instances-panel.tsx`: render responsive instance table/cards, use action menu, improve Probe details, and wide grouped instance Drawer.
- Modify `packages/frontend/src/pages/frp-page.tsx`: polish tab styling only.
- Modify `packages/frontend/src/pages/frp-page.test.tsx`: mapping table, Client hostname fallback, copy, menu delete, pagination, wide drawer tests.
- Modify `packages/frontend/src/pages/frps-instances-panel.test.tsx`: instance table, menu actions, probe details, pagination, wide drawer tests.
- Modify `packages/frontend/src/styles.css` only if repeated table classes become unreadable; prefer Tailwind classes in components.

---

### Task 1: Drawer Width and FRP Action Menu

**Files:**

- Modify: `packages/frontend/src/components/ui/drawer.tsx`
- Create: `packages/frontend/src/pages/frp-action-menu.tsx`
- Test: `packages/frontend/src/pages/frp-page.test.tsx`

**Interfaces:**

- Produces: `Drawer({ size?: "default" | "wide" })` where omitted keeps existing `w-96 max-w-[90vw]` behavior and `wide` uses `w-[720px] max-w-[95vw]`.
- Produces: `FrpActionMenu({ items })` where `items: Array<{ label: string; tone?: "default" | "danger"; disabled?: boolean; onSelect: () => void | Promise<void> }>`.

- [ ] **Step 1: Read and impact-check existing components**

Read:

```text
packages/frontend/src/components/ui/drawer.tsx
packages/frontend/src/pages/frp-page.test.tsx
```

Run GitNexus upstream impact analysis for `Drawer`. If HIGH or CRITICAL, report direct callers before editing. Expected risk: shared component, but optional prop preserves existing callers.

- [ ] **Step 2: Add a failing wide Drawer test through FRP create form**

In `packages/frontend/src/pages/frp-page.test.tsx`, add this assertion to the existing create-drawer test or add a focused test:

```tsx
it("opens the mapping form in a wide drawer", async () => {
 renderPanel({
  list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
  create: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
 });

 await userEvent.click(await screen.findByRole("button", { name: "新增映射" }));
 expect(screen.getByRole("dialog", { name: "创建映射" })).toHaveClass("w-[720px]");
});
```

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/frp-page.test.tsx
```

Expected: FAIL because `Drawer` has no wide size and `FrpPanel` does not pass it.

- [ ] **Step 3: Implement optional Drawer size**

Change `Drawer` props to:

```tsx
export function Drawer({
 open,
 onClose,
 title,
 children,
 size = "default",
}: {
 open: boolean;
 onClose: () => void;
 title: string;
 children: ReactNode;
 size?: "default" | "wide";
}) {
```

Change the panel width class from the fixed `w-96 max-w-[90vw]` fragment to:

```tsx
${size === "wide" ? "w-[720px] max-w-[95vw]" : "w-96 max-w-[90vw]"}
```

Do not change overlay, Escape, title, or children behavior.

- [ ] **Step 4: Create the reusable FRP action menu**

Create `packages/frontend/src/pages/frp-action-menu.tsx`:

```tsx
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface FrpActionMenuItem {
 label: string;
 tone?: "default" | "danger";
 disabled?: boolean;
 onSelect: () => void | Promise<void>;
}

export function FrpActionMenu({ items }: { items: FrpActionMenuItem[] }) {
 const [open, setOpen] = useState(false);
 const root = useRef<HTMLDivElement>(null);

 useEffect(() => {
  if (!open) return;
  const close = (event: MouseEvent) => {
   if (!root.current?.contains(event.target as Node)) setOpen(false);
  };
  const onKey = (event: KeyboardEvent) => {
   if (event.key === "Escape") setOpen(false);
  };
  document.addEventListener("mousedown", close);
  document.addEventListener("keydown", onKey);
  return () => {
   document.removeEventListener("mousedown", close);
   document.removeEventListener("keydown", onKey);
  };
 }, [open]);

 return (
  <div ref={root} className="relative flex justify-end">
   <Button
    type="button"
    size="icon"
    variant="ghost"
    aria-label="更多操作"
    onClick={() => setOpen((value) => !value)}
   >
    <MoreHorizontal className="size-4" />
   </Button>
   {open && (
    <div className="absolute right-0 top-11 z-20 min-w-40 rounded-xl border border-border bg-card p-1 text-sm shadow-xl backdrop-blur-2xl">
     {items.map((item) => (
      <button
       key={item.label}
       type="button"
       disabled={item.disabled}
       className={`block w-full rounded-lg px-3 py-2 text-left disabled:opacity-50 ${item.tone === "danger" ? "text-red-400 hover:bg-red-500/10" : "hover:bg-secondary/70"}`}
       onClick={async () => {
        await item.onSelect();
        setOpen(false);
       }}
      >
       {item.label}
      </button>
     ))}
    </div>
   )}
  </div>
 );
}
```

- [ ] **Step 5: Use `size="wide"` in FRP drawers and verify**

Update `FrpPanel` create drawer to `<Drawer ... size="wide">`. Later tasks will update instance drawers.

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/frp-page.test.tsx
```

Expected: the new wide drawer test PASS and existing FRP tests still PASS.

Commit:

```bash
git add packages/frontend/src/components/ui/drawer.tsx packages/frontend/src/pages/frp-action-menu.tsx packages/frontend/src/pages/frp-panel.tsx packages/frontend/src/pages/frp-page.test.tsx
git commit -m "feat: 增加 FRP 宽抽屉和行操作菜单"
```

---

### Task 2: Mapping Management Table

**Files:**

- Modify: `packages/frontend/src/pages/frp-panel.tsx`
- Modify: `packages/frontend/src/pages/frp-page.test.tsx`

**Interfaces:**

- Consumes: `sdk.clients.list(signal) -> ClientInfo[]` and existing `sdk.frp.list(...)`.
- Produces: mapping rows that display `hostname`, short `clientId`, type/status chips, local endpoint, public endpoint, copy action, delete action, and responsive card markup.

- [ ] **Step 1: Impact-check `FrpPanel`**

Run GitNexus upstream impact analysis for `FrpPanel`. Expected affected direct consumers: `FrpPage`, machine workspace, FRP tests. If HIGH or CRITICAL, report before editing and include machine workspace in verification.

- [ ] **Step 2: Add failing tests for Client hostname and fallback**

In `packages/frontend/src/pages/frp-page.test.tsx`, update `renderPanel()` default client mock to include:

```tsx
clients: {
 list: vi.fn().mockResolvedValue([
  {
   clientId: "client-1",
   hostname: "DESKTOP-DEV",
   os: "win32",
   cpuModel: "cpu",
   totalMemMB: 1,
   totalDiskMB: 1,
   clientVersion: "test",
   capabilities: [],
   online: true,
   cpuPercent: null,
   memPercent: null,
   diskPercent: null,
   lastHeartbeatAt: null,
  },
 ]),
},
```

Add tests:

```tsx
it("shows mapping rows with Client hostname and endpoints", async () => {
 renderPanel({
  list: vi.fn().mockResolvedValue({ data: [mapping("active")], total: 1, page: 1, pageSize: 20, totalPages: 1 }),
  create: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
 });

 expect(await screen.findByText("test-mapping")).toBeVisible();
 expect(screen.getByText("DESKTOP-DEV")).toBeVisible();
 expect(screen.getByText("client-1…")).toBeVisible();
 expect(screen.getByText("TCP")).toBeVisible();
 expect(screen.getByText("运行中")).toBeVisible();
 expect(screen.getByText("127.0.0.1:3000")).toBeVisible();
 expect(screen.getByText("example.com:20080")).toBeVisible();
 expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
});

it("falls back when Client names cannot load", async () => {
 renderPanel({
  list: vi.fn().mockResolvedValue({ data: [mapping("active")], total: 1, page: 1, pageSize: 20, totalPages: 1 }),
  create: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  clients: { list: vi.fn().mockRejectedValue(new Error("offline")) },
 });

 expect(await screen.findByText("未知 Client")).toBeVisible();
 expect(screen.getByText("client-1…")).toBeVisible();
});
```

Run the focused tests and verify RED because `FrpPanel` does not load clients or render the table.

- [ ] **Step 3: Load Client names as optional enrichment**

Inside `FrpPanel`, add `ClientInfo` import and state:

```tsx
const [clients, setClients] = useState<ClientInfo[]>([]);
const [clientsError, setClientsError] = useState(false);
```

Add a `useEffect` tied to `sdk`:

```tsx
useEffect(() => {
 const controller = new AbortController();
 setClientsError(false);
 sdk.clients
  .list(controller.signal)
  .then(setClients)
  .catch(() => {
   if (!controller.signal.aborted) setClientsError(true);
  });
 return () => controller.abort();
}, [sdk]);
```

Build helper values inside render:

```tsx
const clientNames = new Map(clients.map((client) => [client.clientId, client.hostname]));
```

Use helpers:

```tsx
function shortId(value: string) {
 return `${value.slice(0, 8)}…`;
}
function statusLabel(status: string) {
 return status === "active" ? "运行中" : status === "error" ? "异常" : "待启动";
}
function proxyLabel(proxyType: string) {
 return proxyType.toUpperCase();
}
```

- [ ] **Step 4: Replace sparse card list with responsive table/card rows**

For desktop, render a `hidden md:block` table-like grid with columns:

```tsx
<div className="hidden overflow-hidden rounded-2xl border border-border/70 bg-background/40 md:block">
 <div className="grid grid-cols-[1.15fr_1.1fr_.55fr_.75fr_1.05fr_1.15fr_3rem] gap-3 border-b border-border/60 bg-secondary/40 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
  <span>映射</span><span>Client</span><span>类型</span><span>状态</span><span>本地端点</span><span>公网端点</span><span />
 </div>
 {/* rows */}
</div>
```

For mobile, render `md:hidden` compact cards. Use `FrpActionMenu` in both.

Keep delete confirmation state unchanged: menu delete calls `setDeleting(mapping)`.

- [ ] **Step 5: Add and implement copy public URL**

Add test:

```tsx
it("copies the public URL from the row menu", async () => {
 const writeText = vi.fn().mockResolvedValue(undefined);
 Object.assign(navigator, { clipboard: { writeText } });
 renderPanel({
  list: vi.fn().mockResolvedValue({ data: [mapping("active")], total: 1, page: 1, pageSize: 20, totalPages: 1 }),
  create: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
 });
 await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
 await userEvent.click(screen.getByRole("button", { name: "复制公网地址" }));
 expect(writeText).toHaveBeenCalledWith("example.com:20080");
 expect(await screen.findByText("已复制")).toBeVisible();
});
```

Implement `copyingId` / `copyErrorId` local state and:

```tsx
async function copyPublicUrl(mapping: FrpMappingInfo) {
 if (!mapping.publicUrl) return;
 try {
  await navigator.clipboard.writeText(mapping.publicUrl);
  setCopiedId(mapping.id);
  setCopyErrorId("");
 } catch {
  setCopyErrorId(mapping.id);
  setCopiedId("");
 }
}
```

Menu item disabled when `!mapping.publicUrl`.

- [ ] **Step 6: Hide pagination when there is one page**

Change pagination rendering so `上一页`/`下一页` appear only when `(resource.data.totalPages ?? 0) > 1`. Always show `共 N 条映射` below the table.

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/frp-page.test.tsx src/pages/machine-workspace.test.tsx
```

Expected: mapping tests and machine workspace tests PASS.

Commit:

```bash
git add packages/frontend/src/pages/frp-panel.tsx packages/frontend/src/pages/frp-page.test.tsx
git commit -m "style: 优化 FRP 映射管理表格"
```

---

### Task 3: Instance Management Table

**Files:**

- Modify: `packages/frontend/src/pages/frps-instances-panel.tsx`
- Modify: `packages/frontend/src/pages/frps-instances-panel.test.tsx`

**Interfaces:**

- Consumes: `FrpActionMenu`, existing instance operations, local `ProbeResult` state.
- Produces: responsive instance table/cards with default tag, server, port count, dashboard status, health summary, row actions, and structured Probe details.

- [ ] **Step 1: Impact-check instance panel functions**

Run GitNexus upstream impact for `FrpsInstancesPanel`. If graph cannot resolve helpers such as `ProbeDetails`, note that only the exported panel is public and continue after reading the helper bodies.

- [ ] **Step 2: Add failing table and menu tests**

In `packages/frontend/src/pages/frps-instances-panel.test.tsx`, add:

```tsx
it("shows instances in a management table with port count and dashboard status", async () => {
 renderPanel(api());
 expect(await screen.findByText("生产 frps")).toBeVisible();
 expect(screen.getByText("frps_1…")).toBeVisible();
 expect(screen.getByText("1.2.3.4:7000")).toBeVisible();
 expect(screen.getByText("20000–21000")).toBeVisible();
 expect(screen.getByText("1,001 个端口")).toBeVisible();
 expect(screen.getByText("HTTP")).toBeVisible();
 expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
});

it("runs instance actions from the row menu", async () => {
 const probe = vi.fn().mockResolvedValue(healthyProbe);
 const get = vi.fn().mockResolvedValue(instance);
 renderPanel(api({ probe, get }));
 await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
 await userEvent.click(screen.getByRole("button", { name: "健康检查" }));
 expect(probe).toHaveBeenCalledWith("frps_1");
 await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
 await userEvent.click(screen.getByRole("button", { name: "编辑配置" }));
 expect(get).toHaveBeenCalledWith("frps_1");
});
```

Run the test and verify RED because actions are still standalone buttons.

- [ ] **Step 3: Replace instance cards with responsive table/card layout**

Desktop grid header columns:

```tsx
实例 | Server | 端口池 | Dashboard | 健康状态 | 操作
```

Use classes similar to Task 2. Render short instance ID via:

```tsx
function shortId(value: string) {
 return `${value.slice(0, 8)}…`;
}
```

Port count:

```tsx
(instance.portRangeEnd - instance.portRangeStart + 1).toLocaleString("zh-CN")
```

Dashboard status:

```tsx
instance.dashboardHost ? instance.dashboardScheme.toUpperCase() : "未配置"
```

- [ ] **Step 4: Move instance operations into `FrpActionMenu`**

Replace per-row buttons with menu items:

```tsx
<FrpActionMenu
 items={[
  { label: probingId === item.id ? "检查中…" : "健康检查", disabled: probingId === item.id, onSelect: () => probe(item.id) },
  { label: "编辑配置", onSelect: () => openEdit(item) },
  ...(item.isDefault ? [] : [{ label: "设为默认", onSelect: () => setDefault(item.id) }]),
  { label: "删除实例", tone: "danger", onSelect: () => { setActionError(""); setDeleting(item); } },
 ]}
/>
```

- [ ] **Step 5: Improve Probe details and mobile cards**

Keep existing Probe semantics but render details as structured grid:

```tsx
<div className="mt-3 rounded-xl border-l-4 border-emerald-400 bg-secondary/35 p-4 text-sm">
 <div className="grid gap-3 sm:grid-cols-4">...</div>
 {result.proxies && <p className="mt-3 text-muted-foreground">已占用端口：...</p>}
</div>
```

Mobile card mirrors desktop core fields and uses same menu.

- [ ] **Step 6: Use wide Drawer for instance forms**

Change the instance Drawer to `<Drawer ... size="wide">`. Tests should assert edit or create dialog has `w-[720px]`.

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/frps-instances-panel.test.tsx
```

Expected: all instance panel tests PASS.

Commit:

```bash
git add packages/frontend/src/pages/frps-instances-panel.tsx packages/frontend/src/pages/frps-instances-panel.test.tsx
git commit -m "style: 优化 frps 实例管理表格"
```

---

### Task 4: Tab and Drawer Form Polish

**Files:**

- Modify: `packages/frontend/src/pages/frp-page.tsx`
- Modify: `packages/frontend/src/pages/frp-panel.tsx`
- Modify: `packages/frontend/src/pages/frps-instances-panel.tsx`
- Modify: corresponding tests if assertions need updated labels/classes

**Interfaces:**

- Consumes: wide Drawer from Task 1.
- Produces: polished tabs and grouped two-column FRP forms without changing submitted payloads.

- [ ] **Step 1: Impact-check `FrpPage`, `FrpPanel`, and `FrpsInstancesPanel`**

Run GitNexus upstream impact for each exported component. If HIGH/CRITICAL appears, report blast radius before editing and include affected tests in verification.

- [ ] **Step 2: Polish tabs in `FrpPage`**

Keep local state. Replace the plain nav with a rounded segmented container:

```tsx
<nav aria-label="FRP 导航" className="inline-flex rounded-2xl border border-border/70 bg-card/50 p-1 shadow-sm backdrop-blur-xl">
```

Use `secondary` for active and `ghost` for inactive, with `aria-current={section === "mappings" ? "page" : undefined}` on the active button.

- [ ] **Step 3: Group the mapping create form**

Inside the `FrpPanel` Drawer form, wrap fields in sections:

```tsx
<FormSection title="目标" />
<FormSection title="本地服务" />
<FormSection title="公网入口" />
```

Implement `FormSection` as a small local helper in `frp-panel.tsx`:

```tsx
function FormSection({ title, children }: { title: string; children: ReactNode }) {
 return <section className="grid gap-4 rounded-2xl border border-border/60 bg-background/35 p-4 md:grid-cols-2"><h3 className="md:col-span-2 text-sm font-semibold text-muted-foreground">{title}</h3>{children}</section>;
}
```

Import `ReactNode` from React. Do not change field IDs, labels, required attributes, values, or submit logic.

- [ ] **Step 4: Group the instance form**

In `frps-instances-panel.tsx`, add an equivalent local `FormSection` helper or reuse one in the same file. Group fields into:

- 基础连接
- Dashboard
- 端口范围
- 默认设置

Keep `InstanceForm` payload construction exactly equivalent to current behavior.

- [ ] **Step 5: Update tests only for intentional visual labels/classes**

Add assertions:

```tsx
expect(screen.getByText("目标")).toBeVisible();
expect(screen.getByText("基础连接")).toBeVisible();
```

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/frp-page.test.tsx src/pages/frps-instances-panel.test.tsx
```

Expected: PASS.

Commit:

```bash
git add packages/frontend/src/pages/frp-page.tsx packages/frontend/src/pages/frp-panel.tsx packages/frontend/src/pages/frps-instances-panel.tsx packages/frontend/src/pages/frp-page.test.tsx packages/frontend/src/pages/frps-instances-panel.test.tsx
git commit -m "style: 优化 FRP 表单和标签视觉"
```

---

### Task 5: Full Verification and Browser Check

**Files:**

- Verify all files from Tasks 1–4.

**Interfaces:**

- Consumes: all previous task outputs.
- Produces: tested, built, and visually checked FRP management UI.

- [ ] **Step 1: Run full frontend tests**

```bash
pnpm --filter @vcpdeck/frontend test
```

Expected: every frontend Vitest file PASS.

- [ ] **Step 2: Run diagnostics**

Run LSP diagnostics on:

```text
packages/frontend/src
```

Run pi-lens diagnostics `mode=all` for edited files. Expected: no blocking diagnostics.

- [ ] **Step 3: Build frontend**

```bash
pnpm --filter @vcpdeck/frontend build
```

Expected: TypeScript and Vite build complete. Existing dependency-level `"use client"` warnings are acceptable if build exits 0.

- [ ] **Step 4: Browser QA**

Run or use the existing dev server, then inspect `/frp` at desktop width and narrow width. Confirm:

- mapping tab table is compact and no longer has large empty row space;
- Client column shows hostname plus short ID;
- more menus open and close;
- copy action works or shows failure feedback;
- delete confirmation still opens;
- instance tab table aligns with mapping style;
- Probe details expand under the row;
- wide drawers are readable and no field is unreachable.

- [ ] **Step 5: Detect changed flows before final report**

Run:

```text
gitnexus_detect_changes({ scope: "all", repo: "VCPDeck" })
```

Expected frontend changes only in FRP page/panels, Drawer, and tests, plus any pre-existing uncommitted files already present before execution. Investigate any unrelated new frontend changes before finishing.

- [ ] **Step 6: Final status check**

```bash
git status --short
git log --oneline -8
```

Expected: new commits for UI polish tasks; pre-existing uncommitted user changes remain clearly identified and are not accidentally staged unless they are intentional target-file changes reviewed during implementation.
