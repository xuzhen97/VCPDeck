/**
 * dev Client 启动包装：为本地集成测试指定 appDir 后再启动真实入口。
 *
 * 为什么需要：Client 认 Bundle 需要 `<appDir>/apps` 存在（ADR-0030 决策 1），
 * dev 下 appDir 默认是 `process.cwd()`（= packages/client），拿不到 dev Bundle。
 * 这里统一注入 `<repo>/.tmp/devapp`（其 apps 链接由 scripts/ensure-dev-app-layout.cjs
 * 维护），使裸跑 `pnpm dev:all` 无需任何环境变量即可让 Pi 就绪；
 * 显式设置 VCPDECK_APP_DIR 时以调用方为准（发布/安装路径不受影响）。
 *
 * 以子进程方式启动 dist/index.js（入口有 `require.main === module` 守卫，
 * 不能用 require 同进程加载），stdio 继承并转发退出码/信号，行为与 `pnpm start` 一致。
 */
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
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
