import { describe, expect, it } from "vitest";
import {
	MODULES,
	isFullBleed,
	resolveModule,
	visibleSubItems,
} from "./navigation";

describe("resolveModule", () => {
	it("按段边界匹配模块根路径", () => {
		expect(resolveModule("/dashboard")?.id).toBe("dashboard");
		expect(resolveModule("/machines")?.id).toBe("machines");
		expect(resolveModule("/machines/client-1/files")?.id).toBe("machines");
		expect(resolveModule("/settings/profile")?.id).toBe("settings");
		expect(resolveModule("/agent/chat")?.id).toBe("agent");
	});

	it("不做非段边界的前缀匹配", () => {
		expect(resolveModule("/agentxyz")).toBeUndefined();
		expect(resolveModule("/machinesX/files")).toBeUndefined();
	});

	it("未匹配路径返回 undefined 而不是猜测", () => {
		expect(resolveModule("/")).toBeUndefined();
		expect(resolveModule("/unknown/deep")).toBeUndefined();
	});

	it("模块与二级项路径全局唯一", () => {
		const all = MODULES.flatMap((mod) => [
			mod.path,
			...(mod.sub ?? []).map((item) => item.path),
		]);
		expect(new Set(all).size).toBe(all.length);
	});

	it("按设计列出模块与二级项", () => {
		expect(MODULES.map((mod) => mod.label)).toEqual([
			"概览",
			"Agent",
			"机器",
			"任务",
			"映射",
			"发版",
			"设置",
		]);
		expect(MODULES.find((mod) => mod.id === "agent")?.sub?.map((s) => s.label)).toEqual([
			"对话",
			"Profile",
			"Provider",
			"Client 运行时",
		]);
		expect(
			MODULES.find((mod) => mod.id === "settings")?.sub?.map((s) => s.label),
		).toEqual(["个人资料", "Token", "网络", "存储", "身份管理"]);
		expect(MODULES.map((mod) => mod.path)).not.toContain("/storage");
	});
});

describe("isFullBleed", () => {
	it("只对声明 fullBleed 的视图返回 true", () => {
		expect(isFullBleed("/agent/chat")).toBe(true);
		expect(isFullBleed("/agent/chat/")).toBe(true);
		expect(isFullBleed("/agent/profile")).toBe(false);
		expect(isFullBleed("/dashboard")).toBe(false);
		expect(isFullBleed("/agent/chatroom")).toBe(false);
	});
});

describe("visibleSubItems", () => {
	it("非 admin 不返回 adminOnly 项", () => {
		const settings = MODULES.find((mod) => mod.id === "settings");
		expect(visibleSubItems(settings, true).map((s) => s.label)).toContain("身份管理");
		expect(visibleSubItems(settings, false).map((s) => s.label)).not.toContain(
			"身份管理",
		);
	});

	it("无二级模块返回空数组", () => {
		expect(visibleSubItems(MODULES.find((mod) => mod.id === "machines"), true)).toEqual(
			[],
		);
		expect(visibleSubItems(undefined, true)).toEqual([]);
	});
});
