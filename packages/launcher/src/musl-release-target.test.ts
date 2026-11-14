import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClientReleaseTarget } from "./daemon.js";

const created: string[] = [];

async function makeVersionDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-target-"));
	created.push(root);
	return root;
}

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

const VALID_TARGET = {
	schema: 1,
	platform: "linux-x64-musl",
	role: "client",
	runtime: {
		version: "24.22.3",
		url: "https://unofficial-builds.nodejs.org/download/release/v24.22.3/node-v24.22.3-linux-x64-musl.tar.gz",
		sha256: "2db4f8a40abe5f5b5d119964223fedc9c4c7c5e7c632901ae860af522c7844b2",
	},
} as const;

describe("readClientReleaseTarget（Task 5）", () => {
	it("没有描述文件时视为 glibc 双平台包", async () => {
		const dir = await makeVersionDir();
		expect(readClientReleaseTarget(dir)).toBeNull();
	});

	it("读取并严格解析 musl 描述文件", async () => {
		const dir = await makeVersionDir();
		await mkdir(join(dir, "client"), { recursive: true });
		await writeFile(
			join(dir, "client", "release-target.json"),
			`${JSON.stringify(VALID_TARGET, null, 2)}\n`,
			"utf-8",
		);
		expect(readClientReleaseTarget(dir)).toEqual(VALID_TARGET);
	});

	it("描述文件内容不可信时拒绝（不猜测平台）", async () => {
		const dir = await makeVersionDir();
		await mkdir(join(dir, "client"), { recursive: true });
		const path = join(dir, "client", "release-target.json");
		await writeFile(
			path,
			JSON.stringify({ ...VALID_TARGET, platform: "linux-x64" }),
			"utf-8",
		);
		expect(() => readClientReleaseTarget(dir)).toThrow();
		await writeFile(path, "{ not json", "utf-8");
		expect(() => readClientReleaseTarget(dir)).toThrow();
	});
});
