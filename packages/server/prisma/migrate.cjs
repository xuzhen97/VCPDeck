const path = require("path");
const { PrismaLibSql } = require("@prisma/adapter-libsql");

// Adjust path: this script runs from packages/server/
const generatedDir = path.join(
	__dirname,
	"..",
	"generated",
	"client",
	"index.js",
);
const { PrismaClient } = require(generatedDir);

const dbPath = path
	.resolve(__dirname, "..", "prisma", "dev.db")
	.replace(/\\/g, "/");
const factory = new PrismaLibSql({ url: "file:///" + dbPath }, {});
const p = new PrismaClient({ adapter: factory });

async function run() {
	for (const [col, type] of [
		["cpuPercent", "REAL"],
		["memPercent", "REAL"],
		["diskPercent", "REAL"],
		["runningJobs", "TEXT DEFAULT '[]'"],
	]) {
		try {
			await p.$executeRawUnsafe(
				"ALTER TABLE Client ADD COLUMN " + col + " " + type,
			);
			console.log(col + " added");
		} catch (e) {
			console.log(col + ": " + e.message);
		}
	}
	await p.$disconnect();
	console.log("done");
}

run().catch(console.error);
