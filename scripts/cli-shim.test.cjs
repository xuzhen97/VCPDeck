const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const expected = "MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 exec node";

test("link-cli 生成禁用 MSYS 参数转换的 shell shim", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-cli-shim-"));
	try {
		const target = join(dir, "entry.cjs");
		writeFileSync(target, "");
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts", "link-cli.cjs"), `--target=${target}`, `--dir=${dir}`],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const shim = readFileSync(join(dir, "vcpdeck"), "utf8");
		assert.ok(shim.includes(expected));
		assert.match(shim, /"\$@"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("install-cli 使用相同的 MSYS 防护生成 shell shim", () => {
	const source = readFileSync(join(root, "scripts", "install-cli.cjs"), "utf8");
	assert.ok(source.includes(expected));
	assert.ok(source.includes('"$@"'));
});
