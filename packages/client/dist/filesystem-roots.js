"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverRoots = discoverRoots;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
/** 发现客户端可访问的根路径（Files 与 Pi 共用） */
async function discoverRoots() {
    if ((0, node_os_1.platform)() === "win32") {
        const results = await Promise.allSettled(Array.from({ length: 26 }, (_, i) => {
            const drive = String.fromCharCode(65 + i) + ":\\";
            return (0, promises_1.access)(drive).then(() => drive);
        }));
        return results
            .filter((r) => r.status === "fulfilled")
            .map((r) => r.value);
    }
    // Linux / macOS
    try {
        await (0, promises_1.readdir)("/");
        return ["/"];
    }
    catch {
        return [(0, node_os_1.homedir)()];
    }
}
