import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./database-url.js";

describe("resolveDatabaseUrl", () => {
	it("returns the explicit database URL unchanged", () => {
		expect(
			resolveDatabaseUrl("file:C:/Temp/vcpdeck/test.db", "D:/repo/server"),
		).toBe("file:C:/Temp/vcpdeck/test.db");
	});

	it.each([undefined, ""])(
		"defaults to the server development database for %j",
		(databaseUrl) => {
			const cwd = path.resolve("test-server");
			expect(resolveDatabaseUrl(databaseUrl, cwd)).toBe(
				pathToFileURL(path.join(cwd, "prisma", "dev.db")).href,
			);
		},
	);
});
