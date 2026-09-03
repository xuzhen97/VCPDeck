"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	UNIT_FILE,
	UPGRADE_ERROR,
	planSystemdUpgrade,
	runSystemdUpgrade,
} = require("./upgrade-launcher-systemd.cjs");

// 记录型 adapter：记录切换步骤；支持注入失败点。
function makeAdapter(overrides = {}) {
	const calls = [];
	const base = {
		calls,
		record: (n) => calls.push(n),
		exec: (cmd, opts) => {
			// systemctl is-active 判定单元类型。
			if (cmd.includes("is-active") || cmd.includes("cat ")) {
				return {
					status: 0,
					stdout:
					overrides.unitContent ||
					"User=vcpdeck\nGroup=vcpdeck\nExecStart=/opt/vcpdeck/client/launcher/dist/main.js",
				};
			}
			if (cmd.includes("pm2")) return { status: 1, stdout: "" };
			return { status: 0, stdout: "online" };
		},
		statInfo: (p) => {
			// 新 Launcher 存在性由 override 控制。
			if (p.includes("launcher/dist/main.js") && p.startsWith("/opt/vcpdeck/client/apps"))
				return overrides.newLauncher ? { exists: true, type: "file", owner: "root" } : { exists: false };
			if (p === "/opt/vcpdeck/client/launcher/dist/main.js")
				return { exists: overrides.oldLauncher !== false, type: "file", owner: "root" };
			return { exists: true, type: "dir", owner: "root" };
		},
		readFile: () => JSON.stringify({ version: "0.6.15" }),
		execFileSync: (_cmd, _args) => {
			// systemd-run / systemctl 等：默认成功。
			return { status: 0, stdout: "ok" };
		},
		...overrides,
	};
	return base;
}

test("Task5: 单元不是 systemd（PM2 或未知 ExecStart）→ UPGRADE_PM2_UNIT", () => {
	const adapter = makeAdapter({ unitContent: "ExecStart=/home/u/.vcpdeck/launcher-client/main.js" });
	const plan = planSystemdUpgrade(adapter);
	assert.equal(plan.upgradeable, false);
	assert.equal(plan.reason, UPGRADE_ERROR.PM2_UNIT);
});

test("Task5: 旧 Launcher 缺失 → UPGRADE_OLD_MISSING", () => {
	const adapter = makeAdapter({ oldLauncher: false });
	const plan = planSystemdUpgrade(adapter);
	assert.equal(plan.upgradeable, false);
	assert.equal(plan.reason, UPGRADE_ERROR.OLD_MISSING);
});

test("Task5: 新版本 Launcher 未就绪 → UPGRADE_NEW_MISSING", () => {
	const adapter = makeAdapter({ newLauncher: false });
	const plan = planSystemdUpgrade(adapter);
	assert.equal(plan.upgradeable, false);
	assert.equal(plan.reason, UPGRADE_ERROR.NEW_MISSING);
});

test("Task5: 可升级 → 校验 → systemd-run → 校验 → 原子替换 → daemon-reload → restart → 校验新版本", async () => {
	const adapter = makeAdapter({ newLauncher: true });
	const result = await runSystemdUpgrade({
		adapter,
		newVersion: "0.7.0",
		appsDir: "/opt/vcpdeck/client/apps",
		log: () => {},
	});
	const order = adapter.calls;
	// 关键顺序断言：systemd-run 在原子替换之前；daemon-reload/restart 在替换之后。
	const iSystemdRun = order.indexOf("systemd-run");
	const iReplace = order.indexOf("atomic-replace");
	const iReload = order.indexOf("daemon-reload");
	const iRestart = order.indexOf("restart");
	assert.ok(iSystemdRun >= 0, "应有 systemd-run");
	assert.ok(iSystemdRun < iReplace, "systemd-run 应在替换前");
	assert.ok(iReload > iReplace, "daemon-reload 应在替换后");
	assert.ok(iRestart > iReload, "restart 应在 reload 后");
	assert.equal(result.newVersion, "0.7.0");
	assert.ok(order.includes("verify-old") && order.includes("verify-new"));
});

test("Task5: 服务名常量正确", () => {
	assert.ok(UNIT_FILE.includes("vcpdeck-client.service"));
});
