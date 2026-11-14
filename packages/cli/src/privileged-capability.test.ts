import { describe, expect, it } from "vitest";
import type { ClientInfo } from "@vcpdeck/shared";
import {
	formatPrivilegeSummary,
	isRootEquivalent,
	rootEquivalentWarning,
} from "./privileged-capability.js";

/** 构造只带能力摘要的最小 ClientInfo（其余字段与判定无关）。 */
function makeClient(privileged?: unknown): ClientInfo {
	return {
		capabilityDetails: privileged === undefined ? {} : { privileged },
	} as unknown as ClientInfo;
}

const sudoAll = {
	available: true,
	mode: "sudo-all",
	nonInteractive: true,
	runAsUser: "vcpdeck",
};
const directRoot = {
	available: true,
	mode: "direct-root",
	nonInteractive: true,
	runAsUser: "root",
};
const unavailable = {
	available: false,
	mode: "unavailable",
	nonInteractive: false,
	runAsUser: "vcpdeck",
};

describe("CLI 非交互特权展示（ADR-0023 / ADR-0065）", () => {
	it("sudo-all 仍按 root 等价处理", () => {
		const client = makeClient(sudoAll);
		expect(isRootEquivalent(client)).toBe(true);
		expect(formatPrivilegeSummary(client)).toBe("root 等价");
		expect(rootEquivalentWarning(client)).not.toBeNull();
	});

	it("direct-root 是真实 root，同样触发风险提示并明确非沙箱", () => {
		const client = makeClient(directRoot);
		expect(isRootEquivalent(client)).toBe(true);
		expect(formatPrivilegeSummary(client)).toBe(
			"procd · 直接 root（整机权限，非沙箱）",
		);
		expect(rootEquivalentWarning(client)).not.toBeNull();
	});

	it("unavailable 保持旧文案", () => {
		const client = makeClient(unavailable);
		expect(isRootEquivalent(client)).toBe(false);
		expect(formatPrivilegeSummary(client)).toBe("root 等价不可用");
		expect(rootEquivalentWarning(client)).toBeNull();
	});

	it("旧 Client 未报告时显示未报告", () => {
		const client = makeClient();
		expect(isRootEquivalent(client)).toBe(false);
		expect(formatPrivilegeSummary(client)).toBe("未报告");
		expect(rootEquivalentWarning(client)).toBeNull();
	});
});
