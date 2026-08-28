const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const uninstall = require("./uninstall-client.cjs");

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function state(dir, overrides = {}) {
	const { artifact = "client", ...stateOverrides } = overrides;
	writeFileSync(
		join(dir, "launcher.env"),
		`VCPDECK_APP_DIR=${dir}\nVCPDECK_ARTIFACT=${artifact}\n`,
	);
	return {
		version: 1,
		appDir: dir,
		startup: "not-configured",
		...stateOverrides,
	};
}

test("卸载只删除指向目标 appDir 的固定 PM2 Launcher，并保留其他进程", () => {
	const dir = tempDir("vcpdeck-uninstall-");
	try {
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist", "main.js"), "launcher");
		const calls = [];
		const pm2 = { command: "pm2", argsPrefix: [] };
		const runner = (_currentPm2, args, _options = {}) => {
			calls.push(args);
			if (args[0] === "jlist") {
				return JSON.stringify(
					calls.filter((entry) => entry[0] === "delete").length
						? [{ name: "other-app", pm2_env: { pm_exec_path: "/other/app.js" } }]
						: [
								{
									name: "vcpdeck-client-launcher",
									pm2_env: { pm_exec_path: join(dir, "dist", "main.js") },
								},
								{ name: "other-app", pm2_env: { pm_exec_path: "/other/app.js" } },
							],
				);
			}
			return "";
		};
		const result = uninstall.uninstallClient(state(dir), {
			pm2,
			runPm2: runner,
			isWin: false,
		});
		assert.equal(result.removed, true);
		assert.equal(existsSync(dir), false);
		assert.deepEqual(calls, [
			["jlist"],
			["delete", "vcpdeck-client-launcher"],
			["save"],
			["jlist"],
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("同名 PM2 进程指向其他目录时拒绝卸载", () => {
	const dir = tempDir("vcpdeck-uninstall-conflict-");
	try {
		assert.throws(
			() =>
				uninstall.uninstallClient(state(dir), {
					pm2: { command: "pm2", argsPrefix: [] },
					runPm2: (_pm2, args) =>
						args[0] === "jlist"
							? JSON.stringify([
									{
										name: "vcpdeck-client-launcher",
										pm2_env: { pm_exec_path: "/other/app/dist/main.js" },
									},
								])
							: "",
					isWin: false,
				}),
			/PM2 中已存在同名进程但路径不同/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Linux 自启通过 sudo 调用 PM2 unstartup", () => {
	const calls = [];
	const result = uninstall.removeStartup({
		appDir: "/home/user/.vcpdeck/launcher-client",
		startup: `pm2-${require("node:os").userInfo().username}.service`,
		isWin: false,
		pm2: { command: "node", argsPrefix: ["/tools/pm2"] },
		exec: (command, args) => calls.push([command, args]),
	});
	assert.equal(result, "removed");
	assert.deepEqual(calls, [
		[
			"sudo",
			[
				"node",
				"/tools/pm2",
				"unstartup",
				"systemd",
				"-u",
				require("node:os").userInfo().username,
				"--hp",
				require("node:os").homedir(),
			],
		],
	]);
});

test("Windows 自启任务只删除指向目标 Client 的任务", () => {
	const appDir = tempDir("vcpdeck-uninstall-task-");
	const calls = [];
	try {
		const wrapper = join(appDir, "pm2-resurrect.cmd");
		const result = uninstall.removeWindowsStartupTask(
			appDir,
			(command, args) => calls.push([command, args]),
			() => ({ status: 0, stdout: `TaskName: ${wrapper}` }),
		);
		assert.equal(result, "removed");
		assert.deepEqual(calls, [
			["schtasks.exe", ["/Delete", "/TN", "VCPDeck PM2 Startup", "/F"]],
		]);
	} finally {
		rmSync(appDir, { recursive: true, force: true });
	}
});

test("非 Client 安装目录拒绝卸载", () => {
	const dir = tempDir("vcpdeck-uninstall-not-client-");
	try {
		assert.throws(
			() =>
				uninstall.uninstallClient(state(dir, { artifact: "server" }), {
					pm2: { command: "pm2", argsPrefix: [] },
				}),
			/不是 Client 安装目录/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("状态和 appDir 无效时拒绝删除危险路径", () => {
	assert.throws(
		() => uninstall.validateState({ version: 1, appDir: process.env.HOME }),
		/危险|appDir/,
	);
	assert.throws(
		() => uninstall.validateState({ version: 1, appDir: "" }),
		/appDir/,
	);
	assert.throws(
		() =>
			uninstall.validateState({
				version: 1,
				appDir: join(process.env.HOME, ".vcpdeck"),
			}),
		/危险/,
	);
});

test("公开卸载脚本不携带 Server Origin、PSK 或固定用户路径", () => {
	const source = readFileSync(join(__dirname, "uninstall-client.cjs"), "utf8");
	assert.doesNotMatch(source, /VCPDECK_PSK|api\/client-installer|VCPDECK_SERVER/);
	assert.doesNotMatch(source, /C:\\\\Users\\\\/);
});
