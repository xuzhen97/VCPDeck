const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
	createIntegrationTestDb,
	cleanupIntegrationTestDb,
	assertIntegrationTestDb,
} = require("./integration-test-db.cjs");

test("creates and cleans a unique integration database directory", () => {
	const first = createIntegrationTestDb();
	const second = createIntegrationTestDb();
	try {
		assert.notEqual(first.directory, second.directory);
		assert.match(path.basename(first.directory), /^vcpdeck-db-test-/);
		assert.equal(
			first.databaseUrl,
			`file:${path.join(first.directory, "test.db").replace(/\\/g, "/")}`,
		);
		fs.writeFileSync(path.join(first.directory, "test.db"), "test");
	} finally {
		cleanupIntegrationTestDb(first);
		cleanupIntegrationTestDb(second);
	}
	assert.equal(fs.existsSync(first.directory), false);
	assert.equal(fs.existsSync(second.directory), false);
});

test("rejects a database outside the isolated integration-test directory", () => {
	assert.throws(
		() =>
			assertIntegrationTestDb({
				directory: path.resolve("packages/server/prisma"),
				databaseUrl: "file:./prisma/dev.db",
			}),
		/拒绝操作非集成测试数据库/,
	);
});

test("rejects a lookalike directory that only shares the temporary prefix", () => {
	const directory = path.join(
		require("node:os").tmpdir(),
		"vcpdeck-db-test-lookalike",
	);
	assert.throws(
		() =>
			assertIntegrationTestDb({
				directory,
				databaseUrl: `file:${path.join(directory, "test.db").replace(/\\/g, "/")}`,
			}),
		/拒绝操作非集成测试数据库/,
	);
});

test("root integration test no longer deletes the development database", () => {
	const source = fs.readFileSync(path.join(__dirname, "test.cjs"), "utf8");
	assert.doesNotMatch(source, /unlinkSync\s*\(/);
	assert.doesNotMatch(source, /["']dev\.db["']/);
	assert.match(source, /DATABASE_URL:\s*testDatabase\.databaseUrl/);
	assert.doesNotMatch(source, /spawn\("pnpm"[\s\S]*?shell:\s*true/);
	assert.doesNotMatch(source, /pnpm start/);
	assert.match(source, /initializeIntegrationTestDb/);
	assert.match(source, /\.finally\(\(\) =>/);
});
