import { describe, expect, it } from "vitest";
import {
	PI_BUNDLE_PROTOCOL_VERSION,
	parsePiBundleManifest,
} from "./pi-bundle.js";

const validResource = {
	id: "vcp.tool-policy",
	kind: "extension" as const,
	version: "1",
	path: "extensions/vcp-tool-policy/index.js",
	sha256: "a".repeat(64),
};

const valid = {
	protocolVersion: 1,
	bundleVersion: "0.11.0",
	piSdkVersion: "0.86.0",
	resources: [validResource],
};

const withResource = (patch: Record<string, unknown>) => ({
	...valid,
	resources: [{ ...validResource, ...patch }],
});

describe("parsePiBundleManifest", () => {
	it("接受合法 manifest 并保持字段值", () => {
		const manifest = parsePiBundleManifest(valid);
		expect(manifest.protocolVersion).toBe(PI_BUNDLE_PROTOCOL_VERSION);
		expect(manifest.bundleVersion).toBe("0.11.0");
		expect(manifest.piSdkVersion).toBe("0.86.0");
		expect(manifest.resources).toEqual([validResource]);
	});

	it("拒绝未知协议版本", () => {
		expect(() =>
			parsePiBundleManifest({ ...valid, protocolVersion: 2 }),
		).toThrow(/protocolVersion/);
	});

	it("拒绝未知顶层键", () => {
		expect(() => parsePiBundleManifest({ ...valid, extra: 1 })).toThrow(
			/未知字段/,
		);
	});

	it("拒绝缺失字段", () => {
		expect(() =>
			parsePiBundleManifest({ protocolVersion: 1, bundleVersion: "0.11.0" }),
		).toThrow(/缺少字段/);
	});

	it("拒绝绝对路径", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ path: "/etc/passwd" })),
		).toThrow(/相对路径/);
	});

	it("拒绝 .. 逃逸", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ path: "../secrets.js" })),
		).toThrow(/逃逸/);
	});

	it("拒绝反斜杠路径", () => {
		expect(() =>
			parsePiBundleManifest(
				withResource({ path: "extensions\\vcp\\index.js" }),
			),
		).toThrow(/相对路径/);
	});

	it("拒绝重复资源 ID", () => {
		expect(() =>
			parsePiBundleManifest({
				...valid,
				resources: [validResource, { ...validResource, path: "other.js" }],
			}),
		).toThrow(/重复/);
	});

	it("拒绝非法资源 ID", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ id: "VCP ToolPolicy" })),
		).toThrow(/id/);
	});

	it("拒绝未知资源类型", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ kind: "plugin" })),
		).toThrow(/kind/);
	});

	it("拒绝非 64 位十六进制 sha256", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ sha256: "ABC" })),
		).toThrow(/sha256/);
		expect(() =>
			parsePiBundleManifest(withResource({ sha256: "A".repeat(64) })),
		).toThrow(/sha256/);
	});

	it("拒绝资源对象上的未知键", () => {
		expect(() =>
			parsePiBundleManifest(withResource({ extra: true })),
		).toThrow(/未知字段/);
	});

	it("允许空资源列表（首发 Bundle 可只有 manifest）", () => {
		expect(
			parsePiBundleManifest({ ...valid, resources: [] }).resources,
		).toEqual([]);
	});
});
