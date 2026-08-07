import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectCwd, projectKeyFor } from "./project-path.js";

let seq = 0;
async function makeTree() {
	const root = await mkdtemp(join(tmpdir(), `pi-project-${++seq}-`));
	await mkdir(join(root, "project"));
	await mkdir(join(root, "outside"));
	await writeFile(join(root, "project", "file.txt"), "hi");
	return root;
}

describe("resolveProjectCwd", () => {
	it("解析允许根内的目录为 canonical cwd", async () => {
		const root = await makeTree();
		try {
			const { cwd, key } = await resolveProjectCwd(
				{ rootDir: root, relativePath: "project" },
				[root],
			);
			expect(cwd.endsWith("project")).toBe(true);
			expect(key).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("拒绝越界相对路径", async () => {
		const root = await makeTree();
		try {
			await expect(
				resolveProjectCwd({ rootDir: root, relativePath: "../outside" }, [root]),
			).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("拒绝未列出的 root", async () => {
		const root = await makeTree();
		const other = await mkdtemp(join(tmpdir(), `pi-root-${++seq}-`));
		try {
			await expect(
				resolveProjectCwd({ rootDir: other, relativePath: "." }, [root]),
			).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("拒绝通过 symlink 逃逸", async () => {
		const root = await makeTree();
		try {
			try {
				await symlink(join(root, "outside"), join(root, "project", "link"));
			} catch {
				// Windows 无管理员权限时无法创建 symlink，跳过
				return;
			}
			await expect(
				resolveProjectCwd({ rootDir: root, relativePath: "project/link" }, [root]),
			).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("拒绝文件而非目录", async () => {
		const root = await makeTree();
		try {
			await expect(
				resolveProjectCwd({ rootDir: root, relativePath: "project/file.txt" }, [root]),
			).rejects.toMatchObject({ code: "PI_PROJECT_NOT_ALLOWED" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("projectKeyFor", () => {
	it("同一 canonical path 得到相同 key，不同 path 不同", () => {
		const secret = "s3cret";
		const a = projectKeyFor("/repo/a", secret);
		const b = projectKeyFor("/repo/a", secret);
		const c = projectKeyFor("/repo/b", secret);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("不同进程 secret 得到不同 key", () => {
		expect(projectKeyFor("/repo/a", "s1")).not.toBe(projectKeyFor("/repo/a", "s2"));
	});
});
