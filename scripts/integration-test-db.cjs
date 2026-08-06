const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const prefix = path.join(os.tmpdir(), "vcpdeck-test-");

function createIntegrationTestDb() {
	const directory = fs.mkdtempSync(prefix);
	return {
		directory,
		databaseUrl: pathToFileURL(path.join(directory, "test.db")).href,
	};
}

function cleanupIntegrationTestDb(context) {
	if (!context) return;
	if (!path.resolve(context.directory).startsWith(path.resolve(prefix))) {
		throw new Error(`拒绝清理非集成测试目录: ${context.directory}`);
	}
	fs.rmSync(context.directory, { recursive: true, force: true });
}

module.exports = { createIntegrationTestDb, cleanupIntegrationTestDb };
