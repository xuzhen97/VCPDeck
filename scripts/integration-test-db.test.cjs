const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const {
	createIntegrationTestDb,
	cleanupIntegrationTestDb,
} = require("./integration-test-db.cjs");

test("creates and cleans a unique integration database directory", () => {
	const first = createIntegrationTestDb();
	const second = createIntegrationTestDb();
	try {
		assert.notEqual(first.directory, second.directory);
		assert.equal(
			path.dirname(fileURLToPath(first.databaseUrl)),
			first.directory,
		);
		fs.writeFileSync(path.join(first.directory, "test.db"), "test");
	} finally {
		cleanupIntegrationTestDb(first);
		cleanupIntegrationTestDb(second);
	}
	assert.equal(fs.existsSync(first.directory), false);
	assert.equal(fs.existsSync(second.directory), false);
});

test("root integration test no longer deletes the development database", () => {
	const source = fs.readFileSync(path.join(__dirname, "test.cjs"), "utf8");
	assert.doesNotMatch(source, /unlinkSync\s*\(/);
	assert.doesNotMatch(source, /["']dev\.db["']/);
	assert.match(source, /DATABASE_URL:\s*testDatabase\.databaseUrl/);
});
