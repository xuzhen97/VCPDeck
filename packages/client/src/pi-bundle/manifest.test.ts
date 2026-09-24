import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBundleManifest } from "./manifest.js";

const resources = [
	{
		id: "vcp.tool-policy",
		kind: "extension" as const,
		version: "2",
		path: "extensions/vcp-tool-policy/index.js",
		content: Buffer.from("export default function () {}\n"),
	},
	{
		id: "vcp.extra",
		kind: "skill" as const,
		version: "2",
		path: "skills/vcp-extra/SKILL.md",
		content: Buffer.from("# extra\n"),
	},
];

describe("buildBundleManifest", () => {
	it("按 id 排序并写入正确的 sha256", () => {
		const manifest = buildBundleManifest({
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources,
		});

		expect(manifest.protocolVersion).toBe(1);
		expect(manifest.bundleVersion).toBe("0.11.0");
		expect(manifest.piSdkVersion).toBe("0.86.0");
		expect(manifest.resources.map((resource) => resource.id)).toEqual([
			"vcp.extra",
			"vcp.tool-policy",
		]);
		expect(
			manifest.resources.find((r) => r.id === "vcp.tool-policy")?.sha256,
		).toBe(
			createHash("sha256")
				.update("export default function () {}\n")
				.digest("hex"),
		);
	});

	it("不携带文件内容（只声明路径与摘要）", () => {
		const manifest = buildBundleManifest({
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources,
		});
		expect(JSON.stringify(manifest)).not.toContain("export default");
		expect(Object.keys(manifest.resources[0] ?? {}).sort()).toEqual([
			"id",
			"kind",
			"path",
			"sha256",
			"version",
		]);
	});

	it("同一输入生成字节一致的 manifest（可复现构建）", () => {
		const a = buildBundleManifest({
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources,
		});
		const b = buildBundleManifest({
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources: [...resources].reverse(),
		});
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("空资源列表生成合法 manifest（首发只声明支持）", () => {
		const manifest = buildBundleManifest({
			bundleVersion: "0.11.0",
			piSdkVersion: "0.86.0",
			resources: [],
		});
		expect(manifest.resources).toEqual([]);
	});
});
