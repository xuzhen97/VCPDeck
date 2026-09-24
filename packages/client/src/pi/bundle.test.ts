import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVerifiedPiBundle } from "./bundle.js";

const CONTENT = Buffer.from("export default function () {}\n");

interface Fixture {
	appDir: string;
	versionDir: string;
	root: string;
}

/** 造一个 apps/<version>/pi-resources 真实目录树；overrides 用于制造各类失败。 */
async function makeTree(
	overrides: {
		tamper?: boolean;
		dropFile?: boolean;
		symlinkEscape?: boolean;
		sdkVersion?: string;
		skipManifest?: boolean;
	} = {},
): Promise<Fixture> {
	const appDir = await mkdtemp(join(tmpdir(), "vcp-app-"));
	const versionDir = join(appDir, "apps", "0.11.0");
	const root = join(versionDir, "pi-resources");
	const resourceDir = join(root, "extensions", "vcp-tool-policy");
	await mkdir(resourceDir, { recursive: true });

	if (overrides.symlinkEscape) {
		const outside = await mkdtemp(join(tmpdir(), "vcp-outside-"));
		await writeFile(join(outside, "index.js"), CONTENT);
		await rm(resourceDir, { recursive: true, force: true });
		// Windows 上普通 symlink 需要提权（EPERM），目录 junction 不需要
		await symlink(
			outside,
			resourceDir,
			process.platform === "win32" ? "junction" : "dir",
		);
	} else {
		await writeFile(join(resourceDir, "index.js"), CONTENT);
	}

	const digest = createHash("sha256").update(CONTENT).digest("hex");
	const manifest = {
		protocolVersion: 1,
		bundleVersion: "0.11.0",
		piSdkVersion: overrides.sdkVersion ?? "0.86.0",
		resources: [
			{
				id: "vcp.tool-policy",
				kind: "extension",
				version: "2",
				path: "extensions/vcp-tool-policy/index.js",
				sha256: overrides.tamper ? "0".repeat(64) : digest,
			},
		],
	};
	if (overrides.dropFile) await rm(join(resourceDir, "index.js"));
	if (!overrides.skipManifest) {
		await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
	}
	return { appDir, versionDir, root };
}

const resolveFor = (fixture: Pick<Fixture, "appDir" | "versionDir">, sdkVersion = "0.86.0") =>
	resolveVerifiedPiBundle({
		selfDir: join(fixture.versionDir, "client"),
		appDir: fixture.appDir,
		sdkVersion,
	});

describe("resolveVerifiedPiBundle", () => {
	it("校验通过时返回资源 ID 与扩展入口路径", async () => {
		const fixture = await makeTree();

		const bundle = await resolveFor(fixture);

		expect(bundle?.resourceIds).toEqual(["vcp.tool-policy"]);
		expect(bundle?.extensionPaths).toEqual([
			join(fixture.root, "extensions", "vcp-tool-policy", "index.js"),
		]);
		expect(bundle?.manifest.bundleVersion).toBe("0.11.0");
	});

	it("真实发布布局：运行中 Client 位于 apps/<version>/client/dist 时仍能定位版本目录根", async () => {
		const fixture = await makeTree();
		const bundle = await resolveVerifiedPiBundle({
			selfDir: join(fixture.versionDir, "client", "dist"),
			appDir: fixture.appDir,
			sdkVersion: "0.86.0",
		});

		expect(bundle?.resourceIds).toEqual(["vcp.tool-policy"]);
	});

	it("sha256 不符时返回 null（篡改即不可用）", async () => {
		const fixture = await makeTree({ tamper: true });
		await expect(resolveFor(fixture)).resolves.toBeNull();
	});

	it("被引用的文件缺失时返回 null", async () => {
		const fixture = await makeTree({ dropFile: true });
		await expect(resolveFor(fixture)).resolves.toBeNull();
	});

	it("manifest 缺失时返回 null", async () => {
		const fixture = await makeTree({ skipManifest: true });
		await expect(resolveFor(fixture)).resolves.toBeNull();
	});

	it("自身不在 apps/<version> 下时返回 null", async () => {
		const outside = await mkdtemp(join(tmpdir(), "vcp-not-apps-"));
		await expect(
			resolveVerifiedPiBundle({
				selfDir: outside,
				appDir: outside,
				sdkVersion: "0.86.0",
			}),
		).resolves.toBeNull();
	});

	it("manifest 声明的 SDK 版本与本地不一致时返回 null", async () => {
		const fixture = await makeTree();
		await expect(resolveFor(fixture, "0.85.0")).resolves.toBeNull();
	});

	it("资源经符号链接落到 Bundle 根之外时返回 null", async () => {
		const fixture = await makeTree({ symlinkEscape: true });
		await expect(resolveFor(fixture)).resolves.toBeNull();
	});
});
