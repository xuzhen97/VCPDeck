const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const configPath = path.resolve(
	__dirname,
	"../packages/server/prisma.config.cjs",
);

function loadConfig(databaseUrl) {
	const previous = process.env.DATABASE_URL;
	if (databaseUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = databaseUrl;
	delete require.cache[configPath];
	try {
		return require(configPath);
	} finally {
		if (previous === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previous;
		delete require.cache[configPath];
	}
}

test("Prisma config preserves the development default", () => {
	assert.equal(loadConfig(undefined).datasource.url, "file:./prisma/dev.db");
});

test("Prisma config honors DATABASE_URL", () => {
	assert.equal(
		loadConfig("file:C:/Temp/vcpdeck/test.db").datasource.url,
		"file:C:/Temp/vcpdeck/test.db",
	);
});
