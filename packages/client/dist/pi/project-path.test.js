"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const project_path_js_1 = require("./project-path.js");
let seq = 0;
async function makeTree() {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-project-${++seq}-`));
    await (0, promises_1.mkdir)((0, node_path_1.join)(root, "project"));
    await (0, promises_1.mkdir)((0, node_path_1.join)(root, "outside"));
    await (0, promises_1.writeFile)((0, node_path_1.join)(root, "project", "file.txt"), "hi");
    return root;
}
(0, vitest_1.describe)("resolveProjectCwd", () => {
    (0, vitest_1.it)("解析允许根内的目录为 canonical cwd", async () => {
        const root = await makeTree();
        try {
            const { cwd, key } = await (0, project_path_js_1.resolveProjectCwd)({ rootDir: root, relativePath: "project" }, [root]);
            (0, vitest_1.expect)(cwd.endsWith("project")).toBe(true);
            (0, vitest_1.expect)(key).toMatch(/^[0-9a-f]{64}$/);
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("拒绝越界相对路径", async () => {
        const root = await makeTree();
        try {
            await (0, vitest_1.expect)((0, project_path_js_1.resolveProjectCwd)({ rootDir: root, relativePath: "../outside" }, [root])).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("拒绝未列出的 root", async () => {
        const root = await makeTree();
        const other = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-root-${++seq}-`));
        try {
            await (0, vitest_1.expect)((0, project_path_js_1.resolveProjectCwd)({ rootDir: other, relativePath: "." }, [root])).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
            await (0, promises_1.rm)(other, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("拒绝通过 symlink 逃逸", async () => {
        const root = await makeTree();
        try {
            try {
                await (0, promises_1.symlink)((0, node_path_1.join)(root, "outside"), (0, node_path_1.join)(root, "project", "link"));
            }
            catch {
                // Windows 无管理员权限时无法创建 symlink，跳过
                return;
            }
            await (0, vitest_1.expect)((0, project_path_js_1.resolveProjectCwd)({ rootDir: root, relativePath: "project/link" }, [root])).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("拒绝文件而非目录", async () => {
        const root = await makeTree();
        try {
            await (0, vitest_1.expect)((0, project_path_js_1.resolveProjectCwd)({ rootDir: root, relativePath: "project/file.txt" }, [root])).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
        }
        finally {
            await (0, promises_1.rm)(root, { recursive: true, force: true });
        }
    });
});
(0, vitest_1.describe)("projectKeyFor", () => {
    (0, vitest_1.it)("同一 canonical path 得到相同 key，不同 path 不同", () => {
        const secret = "s3cret";
        const a = (0, project_path_js_1.projectKeyFor)("/repo/a", secret);
        const b = (0, project_path_js_1.projectKeyFor)("/repo/a", secret);
        const c = (0, project_path_js_1.projectKeyFor)("/repo/b", secret);
        (0, vitest_1.expect)(a).toBe(b);
        (0, vitest_1.expect)(a).not.toBe(c);
        (0, vitest_1.expect)(a).toMatch(/^[0-9a-f]{64}$/);
    });
    (0, vitest_1.it)("不同进程 secret 得到不同 key", () => {
        (0, vitest_1.expect)((0, project_path_js_1.projectKeyFor)("/repo/a", "s1")).not.toBe((0, project_path_js_1.projectKeyFor)("/repo/a", "s2"));
    });
});
