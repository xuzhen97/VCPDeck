import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseUploadService } from "./release-upload.service.js";

const SHA = "a".repeat(64);
const input = {
	version: "0.2.1",
	platform: "win-x64" as const,
	sha256: SHA,
	size: 100,
};

function release(archives: Record<string, unknown> = {}) {
	return {
		version: "0.2.1",
		archives,
		status: "uploaded",
		clientStates: {},
		createdAt: "2026-08-21T00:00:00.000Z",
		updatedAt: "2026-08-21T00:00:00.000Z",
	};
}

function sessionKey(row: {
	version: string;
	platform: string;
	artifactKind?: string;
	fromVersion?: string;
}): string {
	return JSON.stringify([
		row.version,
		row.platform,
		row.artifactKind ?? "full",
		row.fromVersion ?? "",
	]);
}

function fixture(options: { backend?: "local" | "alibaba"; row?: any } = {}) {
	let row = options.row ?? null;
	const rows = new Map<string, any>();
	const byId = new Map<string, any>();
	if (row) {
		rows.set(sessionKey(row), row);
		byId.set(row.id, row);
	}
	const delegate = {
		findUnique: vi.fn(async ({ where }: any) => {
			if (where.id) return byId.get(where.id) ?? null;
			const unique =
				where.version_platform_artifactKind_fromVersion ?? where.version_platform;
			return rows.get(sessionKey(unique)) ?? null;
		}),
		findMany: vi.fn(async ({ where }: any) =>
			[...byId.values()].filter((item) => item.version === where.version),
		),
		create: vi.fn(async ({ data }: any) => {
			row = {
				...data,
				createdByName: data.createdByName,
				createdVia: data.createdVia,
			};
			rows.set(sessionKey(row), row);
			byId.set(row.id, row);
			return row;
		}),
		delete: vi.fn(async ({ where }: any) => {
			const removed = byId.get(where.id);
			if (removed) {
				rows.delete(sessionKey(removed));
				byId.delete(where.id);
			}
			if (row?.id === where.id) row = null;
		}),
		update: vi.fn(async ({ where, data }: any) => {
			const current = byId.get(where.id) ?? row;
			row = { ...current, ...data };
			rows.set(sessionKey(row), row);
			byId.set(row.id, row);
			return row;
		}),
	};
	const prisma = { releaseUploadSession: delegate };
	const storage = {
		getBackendConfig: vi.fn(async () => ({
			kind: options.backend ?? "alibaba",
			updatedAt: null,
		})),
		createReleaseDirectUpload: vi.fn(async () => ({
			fileId: "provider-file",
			uploadId: "provider-upload",
			partSize: 64,
			parts: [
				{ partNumber: 1, url: "https://provider.invalid/secret-1" },
				{ partNumber: 2, url: "https://provider.invalid/secret-2" },
			],
		})),
		refreshReleaseDirectUploadParts: vi.fn(
			async (_fileId: string, _uploadId: string, partNumbers: number[]) =>
				partNumbers.map((partNumber) => ({
					partNumber,
					url: `https://provider.invalid/refreshed-${partNumber}`,
				})),
		),
		completeReleaseDirectUpload: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	};
	const toPublicArchives = (archives: Record<string, any>) =>
		Object.fromEntries(
			Object.entries(archives).map(([platform, archive]: [string, any]) => {
				if (!archive.storage) return [platform, archive];
				const { key: _key, ...storage } = archive.storage;
				return [platform, { ...archive, storage }];
			}),
		);
	const releases = {
		findByVersion: vi.fn(async () => null as any),
		findByVersionWithStorage: vi.fn(async () => null as any),
		create: vi.fn(async ({ archives }: any) =>
			release(toPublicArchives(archives)) as any,
		),
		replaceArchives: vi.fn(async (_version: string, archives: any) =>
			release(toPublicArchives(archives)) as any,
		),
		addArchive: vi.fn(
			async (_version: string, platform: string, archive: any) =>
				release({ [platform]: archive }) as any,
		),
	};
	const orchestrator = { startRelease: vi.fn(async () => undefined) };
	const service = new ReleaseUploadService(
		prisma as never,
		storage as never,
		releases as never,
		orchestrator as never,
	);
	return {
		service,
		delegate,
		storage,
		releases,
		orchestrator,
		getRow: () => row,
		addRow: (next: any) => {
			rows.set(sessionKey(next), next);
			byId.set(next.id, next);
		},
	};
}

function pendingRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		version: "0.2.1",
		platform: "win-x64",
		artifactKind: "full",
		fromVersion: "",
		expectedFromVersions: "[]",
		sha256: SHA,
		size: 100,
		provider: "alibaba",
		providerKey: "provider-file",
		providerUploadId: "provider-upload",
		partSize: 64,
		status: "pending",
		createdByName: "Operator",
		createdVia: "cli",
		expiresAt: new Date(Date.now() + 60_000),
		...overrides,
	};
}

describe("ReleaseUploadService", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("Local 后端只协商 server 模式", async () => {
		const { service, storage, delegate } = fixture({ backend: "local" });
		await expect(service.createSession(input)).resolves.toEqual({
			mode: "server",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
		expect(delegate.create).not.toHaveBeenCalled();
	});

	it("musl 只接受全量会话，增量在协商前就被拒绝", async () => {
		const { service, delegate } = fixture({ backend: "local" });
		await expect(
			service.createSession({
				...input,
				platform: "linux-x64-musl",
				artifactKind: "delta",
				fromVersion: "0.2.0",
			}),
		).rejects.toThrow("linux-x64-musl 只接受完整构件");
		expect(delegate.create).not.toHaveBeenCalled();
	});

	it("Alibaba 创建持久化会话但不持久化预签名 URL", async () => {
		const { service, delegate, getRow } = fixture();
		const result = await service.createSession(input);
		expect(result).toMatchObject({ mode: "direct", partSize: 64 });
		expect(result.mode === "direct" ? result.parts : []).toHaveLength(2);
		expect(delegate.create).toHaveBeenCalledOnce();
		expect(JSON.stringify(getRow())).not.toContain("provider.invalid");
	});

	it("服务重启后从持久化会话刷新全部分片 URL", async () => {
		const row = pendingRow();
		const { service, storage } = fixture({ row });
		const result = await service.createSession(input);
		expect(result).toMatchObject({ mode: "direct", sessionId: "session-1" });
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
		expect(storage.refreshReleaseDirectUploadParts).toHaveBeenCalledWith(
			"provider-file",
			"provider-upload",
			[1, 2],
		);
	});

	it("相同已登记构件幂等跳过，不同构件拒绝", async () => {
		const { service, releases, storage } = fixture();
		releases.findByVersion.mockResolvedValueOnce(
			release({ "win-x64": { sha256: SHA, size: 100 } }),
		);
		await expect(service.createSession(input)).resolves.toMatchObject({
			mode: "existing",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();

		releases.findByVersion.mockResolvedValueOnce(
			release({ "win-x64": { sha256: "b".repeat(64), size: 100 } }),
		);
		releases.findByVersionWithStorage.mockResolvedValueOnce(null);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_ARCHIVE_EXISTS",
		});
	});

	it("完成前严格校验上传字节数", async () => {
		const { service, storage, releases } = fixture({ row: pendingRow() });
		await expect(service.completeSession("session-1", 99)).rejects.toMatchObject({
			code: "RELEASE_UPLOAD_SIZE_MISMATCH",
		});
		expect(storage.completeReleaseDirectUpload).not.toHaveBeenCalled();
		expect(releases.create).not.toHaveBeenCalled();
	});

	it("完成 Provider 后登记 storage 元数据并更新会话", async () => {
		const { service, storage, releases, delegate } = fixture({
			row: pendingRow(),
		});
		const result = await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledWith(
			"provider-file",
			"provider-upload",
		);
		expect(releases.create).toHaveBeenCalledWith(
			expect.objectContaining({
				archives: {
					"win-x64": expect.objectContaining({
						sha256: SHA,
						size: 100,
						storage: {
							provider: "alibaba",
							key: "provider-file",
							mode: "direct",
						},
					}),
				},
			}),
		);
		expect(delegate.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { status: "completed" },
		});
		expect(result.release.version).toBe("0.2.1");
		expect(JSON.stringify(result.release)).not.toContain("provider-file");
	});

	it("Release 已登记但会话未完成时修复状态且不重复 complete", async () => {
		const { service, releases, storage, delegate } = fixture({
			row: pendingRow(),
		});
		releases.findByVersionWithStorage.mockResolvedValue(
			release({
				"win-x64": {
					sha256: SHA,
					size: 100,
					storage: { provider: "alibaba", key: "provider-file", mode: "direct" },
				},
			}),
		);
		await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).not.toHaveBeenCalled();
		expect(delegate.update).toHaveBeenCalled();
	});

	it("两个平台齐备时触发编排", async () => {
		const { service, releases, orchestrator } = fixture({ row: pendingRow() });
		// 判定已移到共享纯函数，因此由数据本身（双平台构件）驱动，而不是 mock 服务方法
		releases.create.mockResolvedValue(
			release({
				"win-x64": { sha256: SHA, size: 100, fileName: "win.zip" },
				"linux-x64": { sha256: SHA, size: 200, fileName: "linux.zip" },
			}),
		);
		await service.completeSession("session-1", 100);
		await vi.waitFor(() =>
			expect(orchestrator.startRelease).toHaveBeenCalledWith("0.2.1"),
		);
	});

	it("cleaned archive 仍占用版本，不作为幂等已有构件", async () => {
		const { service, releases, storage } = fixture();
		releases.findByVersion.mockResolvedValueOnce(
			release({
				"win-x64": {
					sha256: SHA,
					size: 100,
					fileName: "win.zip",
					availability: "cleaned",
					cleanedAt: "2026-08-29T00:00:00.000Z",
					cleanupReason: "retention_policy",
				},
			}),
		);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_ARCHIVE_EXISTS",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
	});

	it("Provider 合并后登记失败时持久化 provider_completed，重试不重复合并", async () => {
		const { service, storage, releases, delegate } = fixture({
			row: pendingRow(),
		});
		releases.create.mockRejectedValueOnce(new Error("登记暂时失败"));
		await expect(service.completeSession("session-1", 100)).rejects.toThrow(
			"登记暂时失败",
		);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledOnce();
		expect(delegate.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { status: "provider_completed" },
		});

		const result = await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledOnce();
		expect(result.release.version).toBe("0.2.1");
	});

	it("Provider 原始失败归一化为安全稳定错误", async () => {
		const { service, storage } = fixture();
		storage.createReleaseDirectUpload.mockRejectedValue(
			new Error("raw provider token=secret response"),
		);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_UPLOAD_PROVIDER_FAILED",
			message: "外部存储操作失败，请稍后重试",
		});
	});

	it("同一版本平台可并存 full 与 delta 会话并按四元组各自定位", async () => {
		const { service, delegate } = fixture();
		const full = await service.createSession({
			...input,
			artifactKind: "full",
			fromVersion: "",
		});
		const delta = await service.createSession({
			...input,
			artifactKind: "delta",
			fromVersion: "0.22.1",
		});
		expect(full).toMatchObject({ mode: "direct" });
		expect(delta).toMatchObject({ mode: "direct" });
		if (full.mode !== "direct" || delta.mode !== "direct") {
			throw new Error("预期直传模式");
		}
		expect(full.sessionId).not.toBe(delta.sessionId);
		expect(delegate.findUnique).toHaveBeenCalledWith({
			where: {
				version_platform_artifactKind_fromVersion: {
					version: "0.2.1",
					platform: "win-x64",
					artifactKind: "full",
					fromVersion: "",
				},
			},
		});
		expect(delegate.findUnique).toHaveBeenCalledWith({
			where: {
				version_platform_artifactKind_fromVersion: {
					version: "0.2.1",
					platform: "win-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				},
			},
		});
		expect(delegate.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					artifactKind: "full",
					fromVersion: "",
				}),
			}),
		);
		expect(delegate.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			}),
		);
	});

	it("重复同一四元组复用既有会话而非新建冲突会话", async () => {
		const { service, delegate } = fixture();
		const first = await service.createSession({
			...input,
			artifactKind: "delta",
			fromVersion: "0.22.1",
		});
		const second = await service.createSession({
			...input,
			artifactKind: "delta",
			fromVersion: "0.22.1",
		});
		expect(first).toMatchObject({ mode: "direct" });
		expect(second).toMatchObject({ mode: "direct" });
		if (first.mode !== "direct" || second.mode !== "direct") {
			throw new Error("预期直传模式");
		}
		expect(second.sessionId).toBe(first.sessionId);
		expect(delegate.create).toHaveBeenCalledOnce();
	});

	describe("内容寻址增量构件", () => {
		it("首个 full 会话持久化 expectedFromVersions 声明", async () => {
			const { service, delegate } = fixture();
			await service.createSession({
				...input,
				expectedFromVersions: ["0.22.1", "0.22.0"],
			});
			expect(delegate.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						expectedFromVersions: '["0.22.1","0.22.0"]',
					}),
				}),
			);
		});

		it("delta 会话按基线版本命名上传文件", async () => {
			const { service, storage } = fixture();
			await service.createSession({
				...input,
				artifactKind: "delta",
				fromVersion: "0.22.1",
			});
			expect(storage.createReleaseDirectUpload).toHaveBeenCalledWith(
				100,
				"vcpdeck-0.2.1-win-x64-delta-0.22.1.zip",
			);
		});

		it("双平台 full 与 delta 全部就绪才触发编排", async () => {
			const f = fixture();
			f.addRow(
				pendingRow({
					id: "s-full-win",
					platform: "win-x64",
					artifactKind: "full",
					expectedFromVersions: '["0.22.1"]',
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-full-linux",
					platform: "linux-x64",
					artifactKind: "full",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-delta-win",
					platform: "win-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-delta-linux",
					platform: "linux-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			);

			await f.service.completeSession("s-full-win", 100);
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
			await f.service.completeSession("s-full-linux", 100);
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
			await f.service.completeSession("s-delta-win", 100);
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
			const result = await f.service.completeSession("s-delta-linux", 100);

			await vi.waitFor(() =>
				expect(f.orchestrator.startRelease).toHaveBeenCalledWith("0.2.1"),
			);
			expect(result.release.archives["win-x64"]).toMatchObject({
				protocolVersion: 2,
				expectedFromVersions: ["0.22.1"],
				fileName: "vcpdeck-0.2.1-win-x64.zip",
				deltas: [
					{
						fromVersion: "0.22.1",
						fileName: "vcpdeck-0.2.1-win-x64-delta-0.22.1.zip",
					},
				],
			});
			expect(result.release.archives["linux-x64"]).toMatchObject({
				protocolVersion: 2,
				expectedFromVersions: ["0.22.1"],
				fileName: "vcpdeck-0.2.1-linux-x64.zip",
				deltas: [
					{
						fromVersion: "0.22.1",
						fileName: "vcpdeck-0.2.1-linux-x64-delta-0.22.1.zip",
					},
				],
			});
		});

		it("声明的 delta 基线未全部就绪时不触发编排", async () => {
			const f = fixture();
			f.addRow(
				pendingRow({
					id: "s-full-win",
					platform: "win-x64",
					artifactKind: "full",
					expectedFromVersions: '["0.22.1","0.22.0"]',
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-full-linux",
					platform: "linux-x64",
					artifactKind: "full",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-d-win",
					platform: "win-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-d-linux",
					platform: "linux-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			);
			for (const id of ["s-full-win", "s-full-linux", "s-d-win", "s-d-linux"]) {
				await f.service.completeSession(id, 100);
			}
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
		});

		it("delta 早于 full 完成时仍能在 full 就绪后补齐元数据", async () => {
			const f = fixture();
			f.addRow(
				pendingRow({
					id: "s-d-win",
					platform: "win-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-full-win",
					platform: "win-x64",
					artifactKind: "full",
					expectedFromVersions: '["0.22.1"]',
				}),
			);
			await f.service.completeSession("s-d-win", 100);
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
			const result = await f.service.completeSession("s-full-win", 100);
			expect(result.release.archives["win-x64"]).toMatchObject({
				expectedFromVersions: ["0.22.1"],
				deltas: [{ fromVersion: "0.22.1" }],
			});
			expect(f.orchestrator.startRelease).not.toHaveBeenCalled();
		});

		it("reconcileArchives 把每个 delta 会话的 Provider key 写进 archives", async () => {
			const f = fixture();
			f.addRow(
				pendingRow({
					id: "s-d-win",
					platform: "win-x64",
					artifactKind: "delta",
					fromVersion: "0.22.1",
					providerKey: "delta-object",
				}),
			);
			f.addRow(
				pendingRow({
					id: "s-full-win",
					platform: "win-x64",
					artifactKind: "full",
					expectedFromVersions: '["0.22.1"]',
					providerKey: "full-object",
				}),
			);
			await f.service.completeSession("s-d-win", 100);
			await f.service.completeSession("s-full-win", 100);

			const written = (f.releases.create.mock.calls.at(-1)![0] as any)
				.archives as Record<string, any>;
			expect(written["win-x64"].storage).toMatchObject({
				key: "full-object",
			});
			expect(written["win-x64"].deltas).toEqual([
				expect.objectContaining({
					fromVersion: "0.22.1",
					providerKey: "delta-object",
				}),
			]);
		});

		it("Release 已存在其它平台时整表覆盖 archives 而非只追加单平台", async () => {
			const f = fixture();
			f.addRow(
				pendingRow({
					id: "s-full-win",
					platform: "win-x64",
					artifactKind: "full",
				}),
			);
			f.releases.findByVersionWithStorage.mockResolvedValue(
				release({
					"linux-x64": {
						sha256: "b".repeat(64),
						size: 999,
						fileName: "linux.zip",
					},
				}) as any,
			);
			const result = await f.service.completeSession("s-full-win", 100);
			expect(f.releases.replaceArchives).toHaveBeenCalledWith(
				"0.2.1",
				expect.objectContaining({
					"win-x64": expect.objectContaining({ sha256: SHA }),
				}),
			);
			expect(result.release.version).toBe("0.2.1");
		});
	});
});
