import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiCwdRef } from "@vcpdeck/shared";
import {
	loadAgentProjects,
	loadAgentProjectsSnapshot,
	removeAgentProject,
	saveAgentProjects,
	sortAgentProjects,
	toggleAgentProjectPin,
	touchAgentProject,
} from "./pi-recent-projects.js";

const alpha: PiCwdRef = { rootDir: "D:\\", relativePath: "alpha" };
const beta: PiCwdRef = { rootDir: "D:\\", relativePath: "beta" };

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("Agent per-machine recent project index", () => {
	it("isolates projects by machine and migrates only that machine's legacy entries", () => {
		localStorage.setItem("vcpdeck:pi-recent-projects", JSON.stringify([
			{ clientId: "A", ...alpha },
			{ clientId: "A", ...beta },
			{ clientId: "B", rootDir: "X:\\", relativePath: "other" },
		]));
		expect(loadAgentProjects("A")).toHaveLength(2);
		expect(loadAgentProjects("B")).toEqual([{ rootDir: "X:\\", relativePath: "other", pinned: false }]);
	});

	it("touch keeps pin, pin sorts first, and remove only changes local index", () => {
		const recent = touchAgentProject(touchAgentProject([], alpha), beta);
		const pinned = toggleAgentProjectPin(recent, alpha);
		expect(sortAgentProjects(pinned)[0]).toMatchObject(alpha);
		expect(removeAgentProject(pinned, alpha)).toEqual([expect.objectContaining(beta)]);
	});

	it("survives corrupt storage with an empty recoverable index", () => {
		localStorage.setItem("vcpdeck:agent-chat-projects:A", "{");
		expect(loadAgentProjects("A")).toEqual([]);
		expect(loadAgentProjectsSnapshot("A")).toEqual({ projects: [], corrupted: true });
	});

	it("flags non-array storage as corrupted and reports healthy storage as intact", () => {
		localStorage.setItem("vcpdeck:agent-chat-projects:A", JSON.stringify({ rootDir: "D:\\" }));
		expect(loadAgentProjectsSnapshot("A")).toEqual({ projects: [], corrupted: true });

		saveAgentProjects("A", touchAgentProject([], alpha));
		expect(loadAgentProjectsSnapshot("A")).toEqual({
			projects: [{ ...alpha, pinned: false }],
			corrupted: false,
		});
	});

	it("round trips machine-specific entries", () => {
		const projects = touchAgentProject([], alpha);
		saveAgentProjects("A", projects);
		expect(loadAgentProjects("A")).toEqual(projects);
		expect(loadAgentProjects("B")).toEqual([]);
	});
});
