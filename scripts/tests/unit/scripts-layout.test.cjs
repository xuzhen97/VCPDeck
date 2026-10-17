// scripts 分层布局门禁：只读路径和源码，不执行构建、安装、E2E 或云端脚本。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const json = (file) => JSON.parse(read(file));
const publicScripts = [
	"install-cli.cjs",
	"install.cjs",
	"uninstall.cjs",
	"install-client.cjs",
	"install-client-linux.cjs",
	"install-client-bootstrap.sh",
	"install-client-bootstrap.ps1",
	"uninstall-client.cjs",
	"uninstall-client-linux.cjs",
	"uninstall-client-bootstrap.sh",
	"uninstall-client-bootstrap.ps1",
	"upgrade-launcher.cjs",
	"upgrade-launcher-systemd.cjs",
];

// 解析现有的字面量 ROOT 声明，验证目录深度；不 eval 源码。
function assertRepoRoot(file) {
	const source = read(file);
	const declaration = source.match(/const (?:ROOT|root|repoRoot) = (?:path\.)?resolve\(__dirname,\s*((?:["'][^"']+["']\s*,?\s*)+)\);/);
	assert.ok(declaration, `${file} 应声明基于 __dirname 的仓库根`);
	const segments = Array.from(declaration[1].matchAll(/["']([^"']+)["']/g), (match) => match[1]);
	assert.equal(path.resolve(path.dirname(path.join(ROOT, file)), ...segments), ROOT, `${file} 仓库根不可依赖 cwd 或错误层级`);
}

test("package 入口指向分层脚本，默认单测入口不包含危险测试", () => {
	const scripts = json("package.json").scripts;
	for (const [name, target] of Object.entries({
		test: "scripts/tests/e2e/test.cjs",
		release: "scripts/build/pack-release.ts",
		"download:frp": "scripts/build/download-frp.ts",
		"test:frp": "scripts/tests/manual/test-frp.cjs",
		"test:cli": "scripts/tests/e2e/test-cli-capabilities.cjs",
		"test:vcp-plugin": "scripts/tests/e2e/test-vcp-plugin.cjs",
		"vcpdeck:link": "scripts/dev/link-cli.cjs",
	})) {
		assert.ok(scripts[name]?.split(/\s+/).includes(target), `${name} 应使用 ${target}`);
		assert.ok(fs.statSync(path.join(ROOT, target)).isFile(), `${target} 应存在`);
	}
	assert.equal(scripts["test:scripts"], "node --test scripts/tests/unit/*.test.cjs && tsx --test scripts/tests/unit/*.test.ts");
});

test("Client prebuild/dev 使用 dev 目录中的三个入口", () => {
	const scripts = json("packages/client/package.json").scripts;
	assert.equal(scripts.prebuild, "node ../../scripts/dev/ensure-frpc.cjs");
	assert.equal(scripts.dev, "pnpm build && node ../../scripts/dev/wait-for-server.cjs && node ../../scripts/dev/dev-client.cjs");
	for (const name of ["ensure-frpc.cjs", "wait-for-server.cjs", "dev-client.cjs"]) {
		assert.ok(fs.statSync(path.join(ROOT, "scripts/dev", name)).isFile());
	}
});

test("已搬迁的构建、开发和 E2E 入口仍从自身位置解析仓库根", () => {
	for (const file of [
		"scripts/build/bundle-apps.ts",
		"scripts/build/pack-release.ts",
		"scripts/dev/dev-client.cjs",
		"scripts/dev/ensure-frpc.cjs",
		"scripts/dev/link-cli.cjs",
		"scripts/dev/start-test-frps.cjs",
		"scripts/tests/e2e/test.cjs",
		"scripts/tests/e2e/test-cli-capabilities.cjs",
		"scripts/tests/e2e/test-vcp-plugin.cjs",
	]) assertRepoRoot(file);
});

test("无 ROOT 常量的脚本保留下载目录、版本写入目标和 Launcher 路径", () => {
	const downloadFile = "scripts/build/download-frp.ts";
	const download = read(downloadFile);
	for (const [name, target] of Object.entries({
		CLIENT_FRP_DIR: "packages/client/dist/frp",
		SERVER_FRP_DIR: "packages/server/dist/frp",
		TMP_DIR: ".tmp/frp-download",
	})) {
		const declaration = download.match(new RegExp(`const ${name} = path\\.resolve\\(\\s*__dirname,([\\s\\S]*?)\\);`));
		assert.ok(declaration, `${name} 应保留基于 __dirname 的目录声明`);
		const segments = Array.from(declaration[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
		assert.equal(path.resolve(ROOT, path.dirname(downloadFile), ...segments), path.resolve(ROOT, target));
	}
	const inject = read("scripts/build/inject-version.cjs");
	assert.ok(inject.includes('path.resolve(__dirname, `../../packages/${name}/package.json`)'));
	for (const target of ["package.json", "plugins/vcpdeck/plugin-manifest.json", "plugins.json", "packages/shared/src/version.ts"]) {
		assert.ok(inject.includes(`"../../${target}"`), `inject-version 应写入仓库 ${target}`);
		assert.ok(fs.statSync(path.join(ROOT, target)).isFile());
	}
	const smokeFile = "scripts/tests/e2e/smoke-launcher.cjs";
	const smoke = read(smokeFile);
	const entry = smoke.match(/\[path\.join\(__dirname, "([^"]+)"\)\]/)?.[1];
	const cwd = smoke.match(/cwd: path\.join\(__dirname, "([^"]+)"\)/)?.[1];
	assert.ok(entry, "smoke launcher 入口应基于 __dirname");
	assert.ok(cwd, "smoke launcher cwd 应基于 __dirname");
	assert.equal(path.resolve(ROOT, path.dirname(smokeFile), entry), path.join(ROOT, "packages/launcher/dist/main.js"));
	assert.equal(path.resolve(ROOT, path.dirname(smokeFile), cwd), ROOT);
});

test("E2E 引用相邻 helpers 中的隔离数据库工具", () => {
	for (const name of ["test.cjs", "test-cli-capabilities.cjs", "test-vcp-plugin.cjs"]) {
		const file = `scripts/tests/e2e/${name}`;
		const source = read(file);
		const helper = source.match(/require\(["']([^"']*integration-test-db\.cjs)["']\)/)?.[1];
		assert.equal(helper, "../helpers/integration-test-db.cjs", `${name} helper 路径`);
		assert.ok(fs.statSync(path.resolve(ROOT, "scripts/tests/e2e", helper)).isFile());
		assert.match(source, /initializeIntegrationTestDb/);
		assert.match(source, /cleanupIntegrationTestDb/);
	}
});

test("FRPS 开发工具保留，公开根目录仅保留14个入口、tsconfig 及说明", () => {
	const frps = read("scripts/dev/start-test-frps.cjs");
	assert.match(frps, /process\.env\.FRPS_BIN/);
	assert.match(frps, /path\.join\(\s*ROOT,\s*"packages",\s*"server",\s*"dist",\s*"frp"/);
	assert.match(frps, /path\.join\(ROOT, "\.tmp", "test-frps"\)/);
	const rootFiles = fs.readdirSync(path.join(ROOT, "scripts"), { withFileTypes: true })
		.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
	assert.deepEqual(rootFiles, [...publicScripts, "tsconfig.json", "README.md"].sort());
	const config = json("scripts/tsconfig.json");
	assert.ok(config.include.some((pattern) => pattern.replace(/^\.\//, "") === "**/*.ts"), "TS 配置应递归覆盖分层构建脚本和单测");
});

test("发布资产仍从公开根入口复制，Server/Client installer 与发行根目标不变", () => {
	const pack = read("scripts/build/pack-release.ts");
	const server = pack.slice(pack.indexOf("// 3. server 额外文件"), pack.indexOf("// Client 一键升级 Launcher"));
	const client = pack.slice(pack.indexOf("// Client 一键升级 Launcher"), pack.indexOf("// 4. 外部依赖"));
	for (const block of [server, client]) assert.match(block, /const installerDir = join\(target, "installer"\)/);
	const assets = server.match(/for \(const name of \[([\s\S]*?)\]\)/)?.[1];
	assert.ok(assets, "Server 安装资产清单应存在");
	assert.deepEqual(Array.from(assets.matchAll(/"([^"]+)"/g), (match) => match[1]), [
		"install-client-bootstrap.sh", "install-client-bootstrap.ps1", "install-client.cjs",
		"install-client-linux.cjs", "install.cjs", "uninstall-client-bootstrap.sh",
		"uninstall-client-bootstrap.ps1", "uninstall-client.cjs", "uninstall-client-linux.cjs",
	]);
	assert.match(server, /copyInstallerAsset\(join\(ROOT, "scripts", name\), join\(installerDir, name\)\)/);
	for (const name of ["upgrade-launcher.cjs", "upgrade-launcher-systemd.cjs"]) {
		assert.ok(client.includes(`join(ROOT, "scripts", "${name}")`));
		assert.ok(client.includes(`join(installerDir, "${name}")`));
	}
	for (const name of ["install.cjs", "uninstall.cjs"]) {
		assert.ok(pack.includes(`join(ROOT, "scripts", "${name}")`));
		assert.ok(pack.includes(`join(ROOT, args.output, "${name}")`));
	}
});
