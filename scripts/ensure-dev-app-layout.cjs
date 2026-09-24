/**
 * dev 集成测试的布局引导：让 Client 能在本地按发布布局定位 Pi Resource Bundle。
 *
 * 背景：Client 认 Bundle 的规则是硬性的（ADR-0030 §决策 1）——它从自身模块目录向上找
 * `apps/<version>/`，要求 `<version>` 的父目录真实路径等于 `<appDir>/apps`，再读
 * `<version>/pi-resources/manifest.json`。发布包由 scripts/pack-release.ts 生成
 * `apps/<version>/pi-resources/`；本地 dev 没有这层，于是裸跑 `pnpm dev:all` 时
 * Client 上报的 bundle 能力为空，Server 会对需要资源的 Profile fail-closed。
 *
 * 做法：在 `<repo>/.tmp/devapp/apps` 建到 `<repo>/packages` 的链接。dev 下 Client 的
 * appDir 由 scripts/dev-client.cjs 指向 `<repo>/.tmp/devapp`，于是 `packages/client`
 * 自然成为“版本目录”，`packages/client/pi-resources` 就是它的 Bundle —— 内容与校验
 * 方式完全一致（manifest + sha256 + SDK 版本），不放松任何 fail-closed 校验。
 *
 * 链接放在 .tmp/（已被 git ignore）内：若放在 packages/client/apps，vitest 等以 cwd
 * 为根的 glob 工具会把整个仓库的测试再扫一遍（实测 274 个测试文件、多数环境不符失败）。
 *
 * 只服务本地 dev/集成测试；发布安装使用真实的 apps/<version>/ 目录结构。
 */
const { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } = require("node:fs");
const { join, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const appDir = process.env.VCPDECK_APP_DIR ?? join(repoRoot, ".tmp", "devapp");
const linkPath = join(appDir, "apps");
const linkTarget = join(repoRoot, "packages");
const marker = join(linkPath, "client", "pi-resources", "manifest.json");

if (existsSync(marker)) {
	console.log(`[dev-layout] ok: ${linkPath} 可解析到 pi-resources`);
	process.exit(0);
}

let existing = null;
try {
	existing = lstatSync(linkPath);
} catch {
	existing = null;
}

if (existing && !existing.isSymbolicLink()) {
	// 不猜、不删用户目录：只提示并继续（dev:all 仍可跑，只是 Pi 需要资源时不可用）。
	console.warn(`[dev-layout] ${linkPath} 是真实目录，跳过创建链接`);
	process.exit(0);
}

if (existing) {
	// 只删链接本身（绝不 recursive，避免删到链接目标）。
	rmSync(linkPath, { force: true });
}

mkdirSync(appDir, { recursive: true });
symlinkSync(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
console.log(`[dev-layout] created ${linkPath} -> packages（dev Bundle 布局）`);
