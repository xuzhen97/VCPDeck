# FRP Multi-Instance Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an FRP page tab for full frps instance management and let mapping creation target a selected instance through the existing SDK.

**Architecture:** Keep `FrpPage` as the local tab container, retain mapping behavior in `FrpPanel`, and add one focused `FrpsInstancesPanel` for instance CRUD, default selection, and probes. Use existing SDK methods, `useResource`, Drawer, cards, status chips, and confirmation UI; keep probe and form state local to the consuming panel.

**Tech Stack:** React 18, TypeScript strict mode, Vite, Vitest, Testing Library, Tailwind CSS, `@vcpdeck/sdk`, `@vcpdeck/shared`.

## Global Constraints

- All logged-in users can view and operate FRP instance management; do not add an admin check.
- Keep `/frp` as one route; tabs use local React state and reset to “映射” after refresh.
- Do not add dependencies, global context, API wrappers, generic form abstractions, automatic probes, persisted probe state, or port recommendations.
- Mask `authToken` and `dashboardPassword` by default and allow each value to be revealed.
- On update, an empty Dashboard Host must be submitted as `dashboardHost: null`.
- Mapping creation may submit `frpsInstanceId`; omission preserves the server-default fallback.
- Do not change server, shared, or SDK contracts as part of this frontend plan.
- Preserve unrelated working-tree changes in `packages/sdk/src/frp.ts`, server files, and scripts; stage only files named by each task.
- Before editing every existing function or component, run GitNexus upstream impact analysis. The current graph does not resolve `FrpPage`, `FrpPanel`, or `ConfirmTargetDialog`; rebuild the graph first with `node .gitnexus/run.cjs analyze`, retry impact, and warn before editing if risk is HIGH or CRITICAL.

## File Map

- Modify `packages/frontend/src/pages/frp-page.tsx`: own only the “映射 / 实例配置” tab selection.
- Modify `packages/frontend/src/pages/frp-page.test.tsx`: test page tabs and mapping-instance selection while preserving current mapping tests.
- Modify `packages/frontend/src/pages/frp-panel.tsx`: load instance choices when the create Drawer opens, show the selected range, and submit `frpsInstanceId`.
- Create `packages/frontend/src/pages/frps-instances-panel.tsx`: instance list, pagination, form Drawer, default action, probe result, and delete action.
- Create `packages/frontend/src/pages/frps-instances-panel.test.tsx`: cover instance management behavior and request payloads.
- Modify `packages/frontend/src/components/confirm-target-dialog.tsx`: add an optional inline error message so a failed protected delete remains actionable inside the open dialog.

---

### Task 1: Mapping Instance Selector

**Files:**

- Modify: `packages/frontend/src/pages/frp-panel.tsx`
- Modify: `packages/frontend/src/pages/frp-page.test.tsx`

**Interfaces:**

- Consumes: `sdk.frp.instances.list({ page: 1, pageSize: 100 }, signal)` returning `PaginatedResult<FrpsInstanceInfo>`.
- Produces: a create payload whose optional `frpsInstanceId` equals the selected instance ID; omission remains valid when no instance is selected or loading fails.

- [ ] **Step 1: Inspect `FrpPanel` blast radius before editing**

Run GitNexus upstream impact analysis for `FrpPanel`. Expected direct consumers: `FrpPage`, machine workspace usage if indexed, and `frp-page.test.tsx`. Warn and stop first if the refreshed report is HIGH or CRITICAL.

- [ ] **Step 2: Add failing tests for default selection and fallback**

Add a factory near `mapping()` in `frp-page.test.tsx`:

```tsx
const frpsInstance = (isDefault = true): FrpsInstanceInfo => ({
 id: "frps_1",
 name: "生产 frps",
 serverAddr: "1.2.3.4",
 serverPort: 7000,
 authToken: "token",
 dashboardScheme: "http",
 dashboardHost: "1.2.3.4",
 dashboardPort: 7500,
 dashboardUser: "admin",
 dashboardPassword: "secret",
 portRangeStart: 20000,
 portRangeEnd: 21000,
 isDefault,
 createdAt: "2026-07-29T00:00:00.000Z",
 updatedAt: "2026-07-29T00:00:00.000Z",
});
```

Add `FrpsInstanceInfo` to the existing shared type import. Add this test:

```tsx
it("selects the default frps instance when creating a mapping", async () => {
 const create = vi.fn().mockResolvedValue(mapping("active"));
 const listInstances = vi.fn().mockResolvedValue({
  data: [frpsInstance()],
  total: 1,
  page: 1,
  pageSize: 100,
  totalPages: 1,
 });
 renderPanel({
  list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
  create,
  get: vi.fn(),
  delete: vi.fn(),
  instances: { list: listInstances },
 });

 await userEvent.click(await screen.findByRole("button", { name: "新增映射" }));
 expect(await screen.findByLabelText("frps 实例")).toHaveValue("frps_1");
 expect(screen.getByText("1.2.3.4:7000 · 端口范围 20000–21000")).toBeVisible();
 await userEvent.type(screen.getByLabelText("映射名称"), "local-web");
 await userEvent.type(screen.getByLabelText("本地端口"), "3000");
 await userEvent.click(screen.getByRole("button", { name: "创建映射" }));

 expect(create).toHaveBeenCalledWith(
  expect.objectContaining({ frpsInstanceId: "frps_1" }),
  expect.any(AbortSignal),
 );
});
```

Add a second test that rejects `instances.list`, opens the Drawer, asserts `无法加载 frps 实例，将使用服务端默认实例`, submits the form, and expects the first argument to `create` not to have a `frpsInstanceId` property:

```tsx
expect(create.mock.calls[0][0]).not.toHaveProperty("frpsInstanceId");
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frp-page.test.tsx
```

Expected: FAIL because no instance list is loaded and the create payload has no selected instance.

- [ ] **Step 4: Add local instance-choice state and loading**

In `FrpPanel`, import `FrpsInstanceInfo` and add state next to the existing Drawer state:

```tsx
const instanceController = useRef<AbortController>();
const [instances, setInstances] = useState<FrpsInstanceInfo[]>([]);
const [instancesLoading, setInstancesLoading] = useState(false);
const [instancesError, setInstancesError] = useState(false);
const [frpsInstanceId, setFrpsInstanceId] = useState("");
```

Extend cleanup:

```tsx
useEffect(
 () => () => {
  controller.current?.abort();
  instanceController.current?.abort();
 },
 [],
);
```

Make `openDrawer` async and load only when opening:

```tsx
async function openDrawer() {
 setTargetClientId(clientId ?? "");
 resetForm();
 setCreating(false);
 setDrawerOpen(true);
 setInstances([]);
 setInstancesError(false);
 setInstancesLoading(true);
 instanceController.current?.abort();
 const next = new AbortController();
 instanceController.current = next;
 try {
  const result = await sdk.frp.instances.list(
   { page: 1, pageSize: 100 },
   next.signal,
  );
  setInstances(result.data);
  setFrpsInstanceId(result.data.find((item) => item.isDefault)?.id ?? "");
 } catch {
  if (!next.signal.aborted) setInstancesError(true);
 } finally {
  if (!next.signal.aborted) setInstancesLoading(false);
 }
}
```

Add `setFrpsInstanceId("")` to `resetForm()`.

- [ ] **Step 5: Render the selector and submit the optional ID**

Before “代理类型”, render:

```tsx
<div className="space-y-2">
 <Label htmlFor="frps-instance">frps 实例</Label>
 <select
  id="frps-instance"
  className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
  value={frpsInstanceId}
  onChange={(event) => setFrpsInstanceId(event.target.value)}
  disabled={instancesLoading}
 >
  <option value="">使用服务端默认实例</option>
  {instances.map((instance) => (
   <option key={instance.id} value={instance.id}>
    {instance.name}{instance.isDefault ? "（默认）" : ""}
   </option>
  ))}
 </select>
 {instancesLoading && <p className="text-sm text-muted-foreground">正在加载实例…</p>}
 {instancesError && (
  <p role="alert" className="text-sm text-amber-400">
   无法加载 frps 实例，将使用服务端默认实例
  </p>
 )}
 {instances.find((instance) => instance.id === frpsInstanceId) && (
  <p className="text-sm text-muted-foreground">
   {(() => {
    const selected = instances.find((instance) => instance.id === frpsInstanceId)!;
    return `${selected.serverAddr}:${selected.serverPort} · 端口范围 ${selected.portRangeStart}–${selected.portRangeEnd}`;
   })()}
  </p>
 )}
</div>
```

Add this spread to the create request:

```tsx
...(frpsInstanceId ? { frpsInstanceId } : {}),
```

Keep remote port optional but add `min="1" max="65535"` to its input.

- [ ] **Step 6: Run tests, diagnostics, and commit**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frp-page.test.tsx
```

Expected: all `FrpPanel` tests PASS.

Run LSP diagnostics on:

```text
packages/frontend/src/pages/frp-panel.tsx
packages/frontend/src/pages/frp-page.test.tsx
```

Expected: no TypeScript errors.

Commit only this task:

```bash
git add packages/frontend/src/pages/frp-panel.tsx packages/frontend/src/pages/frp-page.test.tsx
git commit -m "feat: 创建映射时选择 frps 实例"
```

---

### Task 2: FRPS Instance Management Panel

**Files:**

- Create: `packages/frontend/src/pages/frps-instances-panel.tsx`
- Create: `packages/frontend/src/pages/frps-instances-panel.test.tsx`
- Modify: `packages/frontend/src/components/confirm-target-dialog.tsx`

**Interfaces:**

- Consumes: `sdk.frp.instances.list/get/create/update/delete/probe/setDefault`, shared `FrpsInstanceInfo`, `FrpsInstanceCreateRequest`, `FrpsInstanceUpdateRequest`, and `ProbeResult`.
- Produces: exported `FrpsInstancesPanel()` used only by `FrpPage`; optional `error?: string` on `ConfirmTargetDialogProps`.

- [ ] **Step 1: Inspect shared confirmation impact before editing**

Run GitNexus upstream impact analysis for `ConfirmTargetDialog`. Expected consumers include mapping, files, identities, tokens, and storage deletion flows. The new prop is optional, so existing call sites must remain source-compatible. Warn and stop before editing if risk is HIGH or CRITICAL.

- [ ] **Step 2: Write the instance panel test harness and failing list/default test**

Create `packages/frontend/src/pages/frps-instances-panel.test.tsx` with shared fixtures:

```tsx
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { FrpsInstanceInfo, IdentityInfo, ProbeResult } from "@vcpdeck/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { FrpsInstancesPanel } from "./frps-instances-panel";

const identity: IdentityInfo = {
 id: "i1",
 username: "operator",
 displayName: "操作员",
 isAdmin: false,
 disabledAt: null,
 createdAt: "2026-07-29T00:00:00.000Z",
};

const instance: FrpsInstanceInfo = {
 id: "frps_1",
 name: "生产 frps",
 serverAddr: "1.2.3.4",
 serverPort: 7000,
 authToken: "token",
 dashboardScheme: "http",
 dashboardHost: "1.2.3.4",
 dashboardPort: 7500,
 dashboardUser: "admin",
 dashboardPassword: "secret",
 portRangeStart: 20000,
 portRangeEnd: 21000,
 isDefault: true,
 createdAt: "2026-07-29T00:00:00.000Z",
 updatedAt: "2026-07-29T00:00:00.000Z",
};

function renderPanel(instances: Record<string, unknown>) {
 const client = {
  auth: { me: async () => identity },
  frp: { instances },
 } as unknown as VcpDeckClient;
 return render(
  <MemoryRouter>
   <SdkProvider client={client}>
    <AuthProvider>
     <FrpsInstancesPanel />
    </AuthProvider>
   </SdkProvider>
  </MemoryRouter>,
 );
}

const listResult = {
 data: [instance],
 total: 1,
 page: 1,
 pageSize: 20,
 totalPages: 1,
};
```

Add a test that renders a non-admin identity, sees `生产 frps`, `默认`, `1.2.3.4:7000`, and does not see `设为默认`. Add a second test with `{ ...instance, isDefault: false }`, click `设为默认`, assert `setDefault("frps_1")`, and use `waitFor` to assert `list` was called twice.

- [ ] **Step 3: Run the new test and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frps-instances-panel.test.tsx
```

Expected: FAIL because `frps-instances-panel.tsx` does not exist.

- [ ] **Step 4: Implement the list, pagination, and default action**

Create `FrpsInstancesPanel` with these exact state boundaries:

```tsx
const [page, setPage] = useState(1);
const load = useCallback(
 (signal: AbortSignal) => sdk.frp.instances.list({ page, pageSize: 20 }, signal),
 [page, sdk],
);
const resource = useResource(load);
const [editing, setEditing] = useState<FrpsInstanceInfo | null>(null);
const [drawerOpen, setDrawerOpen] = useState(false);
const [deleting, setDeleting] = useState<FrpsInstanceInfo | null>(null);
const [actionError, setActionError] = useState("");
const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
const [probingId, setProbingId] = useState("");
```

Use existing `Card`, `Button`, `StatusChip`, `LoadingState`, and `ErrorState`. Render `frps 实例` as the card title and `新增实例` as the primary action. For each instance render address, range, default status, probe status, and actions. Implement default switching as:

```tsx
async function setDefault(instanceId: string) {
 setActionError("");
 try {
  await sdk.frp.instances.setDefault(instanceId);
  resource.reload();
 } catch (error) {
  setActionError(error instanceof Error ? error.message : "设置默认实例失败");
 }
}
```

Pagination must match the existing mapping panel and use `resource.data.totalPages`.

- [ ] **Step 5: Add failing create/edit and secret-visibility tests**

Add tests that:

1. Click `新增实例`, assert both `Auth Token` and `Dashboard 密码` have `type="password"`, click each `显示` button, and assert `type="text"`.
2. Fill required create fields and expect `create` to receive `name`, `serverAddr`, numeric ports/ranges, and `isDefault`.
3. Click `编辑`, wait for `get("frps_1")`, clear Dashboard Host, save, and expect:

```tsx
expect(update).toHaveBeenCalledWith(
 "frps_1",
 expect.objectContaining({ dashboardHost: null }),
);
```

Mock each mutation to resolve with `instance`, and mock `list` for the post-save reload.

- [ ] **Step 6: Implement one local form instead of a generic form layer**

Inside `frps-instances-panel.tsx`, add an `InstanceForm` component with this props contract:

```tsx
function InstanceForm({
 initial,
 onSubmit,
 saving,
 error,
}: {
 initial?: FrpsInstanceInfo;
 onSubmit: (input: FrpsInstanceCreateRequest | FrpsInstanceUpdateRequest) => Promise<void>;
 saving: boolean;
 error: string;
})
```

Initialize fields from `initial` or API defaults: server port `7000`, Dashboard scheme `http`, Dashboard port `7500`, Dashboard user `admin`, range `20000–21000`. Use `Input type="password"` for both secrets and two local booleans for display toggles. Use one `rangeError` string and block submit when start exceeds end:

```tsx
if (Number(portRangeStart) > Number(portRangeEnd)) {
 setRangeError("起始端口不能大于结束端口");
 return;
}
```

Build the payload explicitly so numeric strings become numbers. For Dashboard Host use:

```tsx
dashboardHost: dashboardHost || (initial ? null : undefined),
```

Do not pass `undefined` properties in the final create object; use a conditional spread for create. Only show the `设为默认` checkbox when `initial` is absent.

Before editing an instance, call `sdk.frp.instances.get(instance.id)` and open the Drawer with that detail. On create/update success close the Drawer and call `resource.reload()`; on failure keep it open and show the message near the submit button.

- [ ] **Step 7: Add failing probe presentation tests**

Use this success fixture:

```tsx
const healthyProbe: ProbeResult = {
 ok: true,
 tcpReachable: true,
 tcpLatencyMs: 12,
 dashboardReachable: true,
 authValid: true,
 serverInfo: { version: "0.61.0" },
 proxies: {
  total: 5,
  byType: { tcp: 3, http: 1, https: 1 },
  list: [],
  usedPorts: [20001, 20002],
 },
};
```

Add three tests:

- healthy: shows `TCP 12 ms`, `FRP 0.61.0`, `TCP 3 · HTTP 1 · HTTPS 1`, and `20001, 20002`;
- no Dashboard: `ok: true`, TCP reachable, Dashboard false, auth false, proxies null; shows `TCP 可达，未配置 Dashboard`;
- invalid auth: TCP and Dashboard reachable, auth false; shows `Dashboard 认证无效`.

- [ ] **Step 8: Implement probe state without persistence or automatic calls**

Implement:

```tsx
async function probe(instanceId: string) {
 setProbingId(instanceId);
 setActionError("");
 try {
  const result = await sdk.frp.instances.probe(instanceId);
  setProbes((current) => ({ ...current, [instanceId]: result }));
 } catch (error) {
  setActionError(error instanceof Error ? error.message : "健康检查失败");
 } finally {
  setProbingId("");
 }
}
```

Render the result directly below its instance. Determine summary text in this order:

```tsx
if (!result.tcpReachable) return "TCP 不可达";
if (!instance.dashboardHost) return "TCP 可达，未配置 Dashboard";
if (!result.dashboardReachable) return "Dashboard 不可达";
if (!result.authValid) return "Dashboard 认证无效";
return "健康";
```

Only show proxy totals and used ports when `result.proxies` is non-null. Never call `probe` from an effect or after instance selection.

- [ ] **Step 9: Add failing protected-delete error test**

Add a test where `delete` rejects `new Error("仍有关联的 2 条映射")`. Click `删除`, type `生产 frps` into `输入目标以确认`, click `确认删除`, and assert both the dialog and `仍有关联的 2 条映射` remain visible.

- [ ] **Step 10: Add optional inline error support to confirmation and implement delete**

Extend `ConfirmTargetDialogProps` with:

```tsx
error?: string;
```

Destructure `error` and render before the action buttons:

```tsx
{error && (
 <p role="alert" className="mt-4 text-sm text-red-400">
  {error}
 </p>
)}
```

In `FrpsInstancesPanel`, implement:

```tsx
async function remove() {
 if (!deleting) return;
 setActionError("");
 try {
  await sdk.frp.instances.delete(deleting.id);
  setDeleting(null);
  resource.reload();
 } catch (error) {
  setActionError(error instanceof Error ? error.message : "删除实例失败");
 }
}
```

Pass `error={actionError}` to the confirmation dialog and clear `actionError` only when opening another action or closing the dialog. Existing callers omit the optional prop and remain unchanged.

- [ ] **Step 11: Run panel tests and proactive diagnostics**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frps-instances-panel.test.tsx
```

Expected: all instance list, default, form, probe, and delete tests PASS.

Run LSP diagnostics on:

```text
packages/frontend/src/pages/frps-instances-panel.tsx
packages/frontend/src/pages/frps-instances-panel.test.tsx
packages/frontend/src/components/confirm-target-dialog.tsx
```

Expected: no TypeScript errors.

- [ ] **Step 12: Commit the independently testable instance panel**

```bash
git add packages/frontend/src/pages/frps-instances-panel.tsx packages/frontend/src/pages/frps-instances-panel.test.tsx packages/frontend/src/components/confirm-target-dialog.tsx
git commit -m "feat: 增加 frps 实例管理面板"
```

---

### Task 3: FRP Page Tabs

**Files:**

- Modify: `packages/frontend/src/pages/frp-page.tsx`
- Modify: `packages/frontend/src/pages/frp-page.test.tsx`

**Interfaces:**

- Consumes: existing `FrpPanel({ clientId?: string })` and the `FrpsInstancesPanel()` created in Task 2.
- Produces: `FrpPage()` with local tab state and accessible buttons named `映射` and `实例配置`.

- [ ] **Step 1: Refresh code intelligence and inspect blast radius**

Run:

```bash
node .gitnexus/run.cjs analyze
git status --short
```

Then run GitNexus upstream impact analysis for `FrpPage`. Expected: the report identifies only route/page consumers and tests. If risk is HIGH or CRITICAL, stop and report the affected callers before editing.

- [ ] **Step 2: Add a failing tab-switch test**

In `packages/frontend/src/pages/frp-page.test.tsx`, import `FrpPage`, add `instances` to the mocked FRP API, and add this test beside the existing `FrpPanel` tests:

```tsx
it("switches between mapping and instance panels", async () => {
 const instances = {
  list: vi.fn().mockResolvedValue({
   data: [],
   total: 0,
   page: 1,
   pageSize: 20,
   totalPages: 0,
  }),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  probe: vi.fn(),
  setDefault: vi.fn(),
 };
 const client = {
  auth: { me: async () => identity },
  frp: {
   list: vi.fn().mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
   }),
   get: vi.fn(),
   create: vi.fn(),
   delete: vi.fn(),
   instances,
  },
 } as unknown as VcpDeckClient;

 render(
  <MemoryRouter>
   <SdkProvider client={client}>
    <AuthProvider>
     <FrpPage />
    </AuthProvider>
   </SdkProvider>
  </MemoryRouter>,
 );

 expect(await screen.findByText("全部映射")).toBeVisible();
 await userEvent.click(screen.getByRole("button", { name: "实例配置" }));
 expect(await screen.findByText("frps 实例")).toBeVisible();
 await userEvent.click(screen.getByRole("button", { name: "映射" }));
 expect(await screen.findByText("全部映射")).toBeVisible();
});
```

Also change `renderPanel()` so every test mock has a safe instance list without changing individual test intent:

```tsx
frp: {
 instances: {
  list: vi.fn().mockResolvedValue({
   data: [],
   total: 0,
   page: 1,
   pageSize: 100,
   totalPages: 0,
  }),
 },
 ...frp,
},
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frp-page.test.tsx
```

Expected: FAIL because `FrpPage` has no `实例配置` control and `FrpsInstancesPanel` does not exist.

- [ ] **Step 4: Add the smallest page-local tab container**

After Task 2 has created `FrpsInstancesPanel`, replace `FrpPage` with:

```tsx
import { useState } from "react";
import { PageHeading } from "@/components/page-heading";
import { Button } from "@/components/ui/button";
import { FrpPanel } from "./frp-panel";
import { FrpsInstancesPanel } from "./frps-instances-panel";

export function FrpPage() {
 const [section, setSection] = useState<"mappings" | "instances">("mappings");
 return (
  <div className="space-y-6">
   <PageHeading
    title="FRP"
    description="管理在线 Client 的公网映射与 frps 实例。"
   />
   <nav aria-label="FRP 导航" className="flex gap-2 border-b border-border/70 pb-3">
    <Button
     variant={section === "mappings" ? "secondary" : "ghost"}
     onClick={() => setSection("mappings")}
    >
     映射
    </Button>
    <Button
     variant={section === "instances" ? "secondary" : "ghost"}
     onClick={() => setSection("instances")}
    >
     实例配置
    </Button>
   </nav>
   {section === "mappings" ? <FrpPanel /> : <FrpsInstancesPanel />}
  </div>
 );
}
```

- [ ] **Step 5: Run the focused test and commit the page boundary**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/frp-page.test.tsx
```

Expected: PASS after Tasks 1 and 2 are present.

Commit only the page-container changes:

```bash
git add packages/frontend/src/pages/frp-page.tsx packages/frontend/src/pages/frp-page.test.tsx
git commit -m "feat: 增加 FRP 页面标签"
```

---

### Task 4: Integrated Verification

**Files:**

- Verify: `packages/frontend/src/pages/frp-page.tsx`
- Verify: `packages/frontend/src/pages/frp-panel.tsx`
- Verify: `packages/frontend/src/pages/frps-instances-panel.tsx`
- Verify: `packages/frontend/src/components/confirm-target-dialog.tsx`
- Verify: corresponding tests

**Interfaces:**

- Consumes: all outputs from Tasks 1–3.
- Produces: a verified frontend build with no unexpected execution-flow changes.

- [ ] **Step 1: Run the complete frontend test suite**

```bash
pnpm --filter @vcpdeck/frontend test
```

Expected: all frontend Vitest files PASS, including pre-existing mapping polling and deletion tests.

- [ ] **Step 2: Run proactive diagnostics before the build**

Run LSP diagnostics on `packages/frontend/src/` and fix only errors caused by this plan. Expected: no TypeScript errors in changed files.

Run session diagnostics with `lens_diagnostics` mode `all`. Expected: no blocking errors for edited files.

- [ ] **Step 3: Build the frontend**

```bash
pnpm --filter @vcpdeck/frontend build
```

Expected: TypeScript compilation and Vite production build complete successfully.

- [ ] **Step 4: Review the final blast radius**

Run:

```text
gitnexus_detect_changes({ scope: "all", repo: "VCPDeck" })
```

Expected frontend changes: FRP page rendering, mapping creation, instance management, and the optional confirmation error surface. Investigate any unrelated flow reported before proceeding.

- [ ] **Step 5: Confirm only intended files are staged or committed**

```bash
git status --short
git log --oneline -4
```

Expected: the user’s pre-existing SDK/server/script modifications remain unstaged and unchanged; this implementation consists only of the frontend files listed in the File Map.
