import { expect, it } from "vitest";
import { isSupportedNodeVersion } from "./node-version.js";

it.each([
	["22.18.99", false],
	["22.19.0", true],
	["22.19.1", true],
	["v23.0.0", true],
	["24.0.0", true],
	["invalid", false],
	["", false],
])("判断 Node %s", (version, expected) => {
	expect(isSupportedNodeVersion(version)).toBe(expected);
});
