import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = fileURLToPath(new URL("./index.mjs", import.meta.url));

const FIXTURE_SKILL =
	"---\nname: vcpdeck\ndescription: 仅用于隔离测试的技能描述\n---\n\n# 正文\n";

/**
 * 建立一份与真实安装布局一致的临时副本，使测试可独立控制技能与 CLI 正文。
 * @returns 临时根目录、技能目录、技能文件与 CLI 文件路径
 */
async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck dsh fixture "));
	const skillsDir = join(root, "skills", "vcpdeck");
	const dshDir = join(root, "dsh");
	await mkdir(skillsDir, { recursive: true });
	await mkdir(dshDir, { recursive: true });
	await copyFile(ENTRY, join(dshDir, "index.mjs"));
	await writeFile(join(skillsDir, "SKILL.md"), FIXTURE_SKILL, "utf8");
	await writeFile(join(skillsDir, "vcpdeck.cjs"), "#!/usr/bin/env node\n", "utf8");
	return {
		root,
		skillsDir,
		skillPath: join(skillsDir, "SKILL.md"),
		cliPath: join(skillsDir, "vcpdeck.cjs"),
		entryPath: join(dshDir, "index.mjs"),
	};
}

/**
 * 以唯一查询串导入临时副本，避免模块缓存导致多个用例共用同一实例。
 * @param {string} entryPath 临时入口文件路径
 * @returns 入口模块命名空间
 */
async function importEntry(entryPath) {
	const url = `${pathToFileURL(entryPath).href}?t=${Date.now()}${Math.random()}`;
	return import(url);
}

/**
 * 构造只覆盖技能注册表与 effect 生命周期的最小宿主上下文。
 * @returns 上下文与测试可观察的释放标记
 */
function createStubContext() {
	const state = { released: false, provider: undefined };
	const ctx = {
		skills: {
			registerProvider(create) {
				state.provider = create({
					signal: new AbortController().signal,
					invalidate() {},
				});
				return () => {
					state.released = true;
				};
			},
		},
		effect(register) {
			return register();
		},
	};
	return { ctx, state };
}

test("注册用户与模型均可调用的 vcpdeck 技能", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply, inject } = await importEntry(fixture.entryPath);
	assert.deepEqual(inject, ["skills"]);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);

	const [candidate] = await state.provider.list({});
	assert.equal(candidate.name, "vcpdeck");
	assert.equal(candidate.provider, state.provider.name);
	assert.equal(candidate.description, "仅用于隔离测试的技能描述");
	assert.deepEqual(candidate.invocation, {
		modelInvocable: true,
		userInvocable: true,
	});
	assert.equal(candidate.rank, 600);
	assert.equal(candidate.resourceBase.kind, "directory");
	assert.equal(candidate.resourceBase.path, fixture.skillsDir);

	const definition = await state.provider.get(candidate, {
		signal: new AbortController().signal,
	});
	assert.ok(definition.content.includes("vcpdeck.cjs"));
	assert.ok(definition.content.includes(JSON.stringify(fixture.cliPath)));
	assert.equal(state.released, false);
	cleanup();
	assert.equal(state.released, true);
});

test("每次加载都重新读取技能正文", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);
	t.after(cleanup);

	const [before] = await state.provider.list({});
	const first = await state.provider.get(before, {});
	assert.ok(first.content.includes("# 正文"));
	await writeFile(
		fixture.skillPath,
		FIXTURE_SKILL.replace("# 正文", "# 修订后的正文"),
		"utf8",
	);
	const [after] = await state.provider.list({});
	const second = await state.provider.get(after, {});
	assert.ok(second.content.includes("# 修订后的正文"));
	assert.ok(!second.content.includes("\n# 正文\n"));
});

test("安装构件缺失时立即失败，不改用其他 CLI", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	await rm(fixture.cliPath, { force: true });
	const { ctx } = createStubContext();
	assert.throws(() => apply(ctx), /安装构件缺失/);
});

test("技能文件缺失时立即失败", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	await rm(fixture.skillPath, { force: true });
	const { ctx } = createStubContext();
	assert.throws(() => apply(ctx), /安装构件缺失/);
});

test("frontmatter 不符合约定时明确拒绝", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	apply(ctx);
	await writeFile(fixture.skillPath, "# 没有 frontmatter\n", "utf8");
	await assert.rejects(() => state.provider.list({}), /缺少 YAML frontmatter/);

	await writeFile(
		fixture.skillPath,
		"---\nname: other\ndescription: 名称不符\n---\n\n# 正文\n",
		"utf8",
	);
	await assert.rejects(() => state.provider.list({}), /name 必须是 vcpdeck/);

	await writeFile(fixture.skillPath, "---\nname: vcpdeck\n---\n\n# 正文\n", "utf8");
	await assert.rejects(() => state.provider.list({}), /description 不能为空/);
});

test("宿主取消信号会中止技能读取", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);
	t.after(cleanup);

	const [candidate] = await state.provider.list({});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => state.provider.get(candidate, { signal: controller.signal }),
		/abort/i,
	);
});

test("候选不携带任何凭据字段", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);
	t.after(cleanup);

	const [candidate] = await state.provider.list({});
	assert.equal(candidate.source, "bundled");
	assert.equal(candidate.locator, fixture.skillPath);
	for (const key of Object.keys(candidate)) {
		assert.doesNotMatch(key, /token|password|secret|credential/i);
	}
});

test("构件是目录而不是文件时拒绝注册", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	await rm(fixture.cliPath, { force: true });
	await mkdir(fixture.cliPath, { recursive: true });
	const { ctx } = createStubContext();
	assert.throws(() => apply(ctx), /安装构件不是文件/);
});

test("拒绝会被静默误解析的 frontmatter", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);
	t.after(cleanup);

	await writeFile(
		fixture.skillPath,
		"---\nname: vcpdeck\ndescription: >\n  折叠标量\n---\n\n# 正文\n",
		"utf8",
	);
	await assert.rejects(() => state.provider.list({}), /不支持的 YAML 指示符/);

	await writeFile(
		fixture.skillPath,
		"---\nname: vcpdeck\n  description: 缩进\n---\n\n# 正文\n",
		"utf8",
	);
	await assert.rejects(() => state.provider.list({}), /不支持缩进块/);
});

test("只读取本安装实例内的技能文件", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const { apply } = await importEntry(fixture.entryPath);
	const { ctx, state } = createStubContext();
	const cleanup = apply(ctx);
	t.after(cleanup);

	await assert.rejects(
		() => state.provider.get({ locator: join(fixture.root, "SKILL.md") }, {}),
		/只允许读取本插件安装实例内的技能文件/,
	);
});

test("包分发声明指向真实资源", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(manifest.exports["."], "./dsh/index.mjs");
	assert.equal(manifest.exports["./dsh"], "./dsh/index.mjs");
	assert.equal(manifest.dsh.bundle.patch, "./dsh/cordis.patch.yml");
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
	for (const file of [
		"dsh/index.mjs",
		"dsh/cordis.patch.yml",
		"skills/vcpdeck/SKILL.md",
		"skills/vcpdeck/vcpdeck.cjs",
	]) {
		assert.ok(manifest.files.includes(file), `分发清单缺少 ${file}`);
		assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} 不存在`);
	}
	const patch = await readFile(
		new URL("../dsh/cordis.patch.yml", import.meta.url),
		"utf8",
	);
	assert.match(patch, /name: vcpdeck\/dsh/u);
});

test("共用技能保持宿主中立且保留 frontmatter 兼容性", async () => {
	const raw = await readFile(
		new URL("../skills/vcpdeck/SKILL.md", import.meta.url),
		"utf8",
	);
	assert.match(raw, /^---\r?\nname: vcpdeck\r?\n/u);
	assert.match(raw, /^compatibility: /mu);
	assert.doesNotMatch(raw, /^disable-model-invocation:/mu);
	assert.doesNotMatch(raw, /from Pi:/u);
	assert.doesNotMatch(raw, /保持 Pi 当前项目/u);
});
