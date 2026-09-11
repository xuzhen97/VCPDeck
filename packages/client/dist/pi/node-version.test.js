"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_version_js_1 = require("./node-version.js");
vitest_1.it.each([
    ["22.18.99", false],
    ["22.19.0", true],
    ["22.19.1", true],
    ["v23.0.0", true],
    ["24.0.0", true],
    ["invalid", false],
    ["", false],
])("判断 Node %s", (version, expected) => {
    (0, vitest_1.expect)((0, node_version_js_1.isSupportedNodeVersion)(version)).toBe(expected);
});
