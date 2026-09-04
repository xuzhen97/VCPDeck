import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VCP_COMMANDS } from "../src/dispatcher.js";

const manifest = JSON.parse(
	readFileSync(resolve(__dirname, "../../../plugins/vcpdeck/plugin-manifest.json"), "utf8"),
);

const commands = manifest.capabilities.invocationCommands as {
	command?: string;
	commandIdentifier?: string;
	description: string;
	example: string;
	parameters?: Record<string, unknown>;
}[];

/** 与 VCPToolBox ToolCallParser._scanFields 等价的字段扫描 */
function scanFields(blockContent: string): { key: string; value: string }[] {
	const re = /([a-zA-Z_][a-zA-Z0-9_]*):「始」([^」]*)「末」/g;
	const fields: { key: string; value: string }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(blockContent))) {
		fields.push({ key: m[1], value: m[2] });
	}
	return fields;
}

describe("VCPDeckBridge Manifest Contract", () => {
	it("uses command (not commandIdentifier) on every item", () => {
		for (const item of commands) {
			expect("commandIdentifier" in item).toBe(false);
			expect(typeof item.command).toBe("string");
			expect(item.command!.length).toBeGreaterThan(0);
		}
	});

	it("command set matches VCP_COMMANDS exactly", () => {
		expect(commands.map((c) => c.command).sort()).toEqual([...VCP_COMMANDS].sort());
	});

	it("every example is a complete TOOL_REQUEST block", () => {
		for (const item of commands) {
			expect(item.example).toContain("<<<[TOOL_REQUEST]>>>");
			expect(item.example).toContain("<<<[END_TOOL_REQUEST]>>>");
		}
	});

	it("every example has tool_name=VCPDeckBridge and correct command field", () => {
		for (const item of commands) {
			const block = item.example.slice(
				item.example.indexOf("<<<[TOOL_REQUEST]>>>") + 19,
				item.example.indexOf("<<<[END_TOOL_REQUEST]>>>"),
			);
			const fields = scanFields(block);
			const toolName = fields.find((f) => f.key === "tool_name");
			expect(toolName?.value).toBe("VCPDeckBridge");
			const cmdFields = fields.filter((f) => f.key === "command");
			expect(cmdFields.length).toBe(1);
			expect(cmdFields[0].value).toBe(item.command);
		}
	});

	it("RunShellJob example uses shellCommand and no duplicate command field", () => {
		const runItem = commands.find((c) => c.command === "RunShellJob");
		expect(runItem).toBeDefined();
		const block = runItem!.example.slice(
			runItem!.example.indexOf("<<<[TOOL_REQUEST]>>>") + 19,
			runItem!.example.indexOf("<<<[END_TOOL_REQUEST]>>>"),
		);
		const fields = scanFields(block);
		expect(fields.some((f) => f.key === "shellCommand")).toBe(true);
		expect(fields.filter((f) => f.key === "command").length).toBe(1);
	});

	it("no item retains a parameters object (not consumed by VCPToolBox)", () => {
		for (const item of commands) {
			expect("parameters" in item).toBe(false);
		}
	});
});
