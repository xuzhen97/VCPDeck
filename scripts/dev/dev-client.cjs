/**
 * dev Client 启动包装：为本地集成测试指定 appDir 后再启动真实入口。
 *
 * 本地开发默认注入 `<repo>/.tmp/devapp` 作为 appDir，避免与包源码目录混用。
 * 显式设置 VCPDECK_APP_DIR 时以调用方为准（发布/安装路径不受影响）。
 * Agent/Pi 专用开发布局已随 ADR-0049 退役，不再准备 Bundle 或 apps 链接。
 *
 * 以子进程方式启动 dist/index.js（入口有 `require.main === module` 守卫，
 * 不能用 require 同进程加载），stdio 继承并转发退出码/信号，行为与 `pnpm start` 一致。
 */
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const clientDir = join(repoRoot, "packages", "client");
const appDir = process.env.VCPDECK_APP_DIR ?? join(repoRoot, ".tmp", "devapp");

const child = spawn(process.execPath, [join(clientDir, "dist", "index.js")], {
	cwd: clientDir,
	stdio: "inherit",
	env: { ...process.env, VCPDECK_APP_DIR: appDir },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		try {
			child.kill(signal);
		} catch {
			/* 子进程已退出 */
		}
	});
}

child.on("exit", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});
