const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const prefix = path.join(os.tmpdir(), "vcpdeck-db-test-");

function createIntegrationTestDb() {
	const directory = fs.mkdtempSync(prefix);
	const databasePath = path.join(directory, "test.db").replace(/\\/g, "/");
	return { directory, databaseUrl: `file:${databasePath}` };
}

function cleanupIntegrationTestDb(context) {
	if (!context) return;
	if (!path.resolve(context.directory).startsWith(path.resolve(prefix))) {
		throw new Error(`拒绝清理非集成测试目录: ${context.directory}`);
	}
	fs.rmSync(context.directory, { recursive: true, force: true });
}

module.exports = { createIntegrationTestDb, cleanupIntegrationTestDb };
