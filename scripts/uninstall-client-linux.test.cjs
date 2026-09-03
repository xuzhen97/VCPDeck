"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	SERVICE_NAME,
	UNINSTALL_ERROR,
	planUninstall,
	runUninstall,
} = require("./uninstall-client-linux.cjs");

const UNIT_CONTENT_SYSTEMD = "User=vcpdeck\nGroup=vcpdeck\nExecStart=/opt/vcpdeck/client/launcher/dist/main.js";
const UNIT_CONTENT_PM2 = "ExecStart=/home/u/.vcpdeck/launcher-client/main.js";

function makeAdapter(overrides = {}) {
	const calls = [];
	const base = {
		calls,
		record: (n) => calls.push(n),
		exec: (cmd) => {
			if (cmd.includes("cat ") || cmd.includes("is-active"))
				return { status: 0, stdout: overrides.unitContent || UNIT_CONTENT_SYSTEMD };
			return { status: 0, stdout: "ok" };
		},
		execFileSync: (_c, _a) => ({ status: 0, stdout: "ok" }),
		statInfo: () => ({ exists: true, type: "dir", owner: "root" }),
		rm: () => {},
		chown: () => {},
		chmod: () => {},
		...overrides,
	};
	return base;
}

test("Task6: 单元是 PM2/用户服务而非 systemd → UNINSTALL_PM2_UNIT（拒绝，需走 PM2 卸载）", () => {
	const adapter = makeAdapter({ unitContent: UNIT_CONTENT_PM2 });
	const plan = planUninstall(adapter);
	assert.equal(plan.uninstallable, false);
	assert.equal(plan.reason, UNINSTALL_ERROR.PM2_UNIT);
});

test("Task6: systemd 单元 → 可卸载；顺序 stop → 删单元/sudoers/env/opt/var → daemon-reload → 删账户 → 校验消失", async () => {
	const adapter = makeAdapter();
	const result = await runUninstall({ adapter, log: () => {} });
	const order = adapter.calls;
	const iStop = order.indexOf("stop-service");
	const iRmUnit = order.indexOf("remove-unit");
	const iReload = order.indexOf("daemon-reload");
	const iDelAccount = order.indexOf("delete-account");
	const iVerify = order.indexOf("verify-gone");
	assert.ok(iStop >= 0 && iStop < iRmUnit, "stop 在前");
	assert.ok(iRmUnit < iReload, "删单元在 reload 前");
	assert.ok(iReload < iDelAccount, "reload 在删账户前");
	assert.ok(iDelAccount < iVerify, "删账户在最终校验前");
	assert.ok(order.includes("remove-sudoers") && order.includes("remove-env") && order.includes("remove-opt") && order.includes("remove-var"));
	assert.equal(result.removed, true);
});

test("Task6: --purge 额外删除 Release 缓存与迁移状态；默认不清理", async () => {
	const adapter = makeAdapter();
	await runUninstall({ adapter, purge: true, log: () => {} });
	assert.ok(adapter.calls.includes("purge-release-cache"));
	assert.ok(adapter.calls.includes("purge-migration-state"));

	const defaultAdapter = makeAdapter();
	await runUninstall({ adapter: defaultAdapter, log: () => {} });
	assert.ok(!defaultAdapter.calls.includes("purge-release-cache"));
	assert.ok(!defaultAdapter.calls.includes("purge-migration-state"));
});

test("Task6: 服务名常量正确", () => {
	assert.equal(SERVICE_NAME, "vcpdeck-client.service");
});
