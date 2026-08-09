import type {
	SessionEntry,
	SessionInfo as PiSdkSessionInfo,
} from "@earendil-works/pi-coding-agent";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Pi SDK 是 ESM-only；Client 编译为 CJS，静态 import 会触发
 * ERR_PACKAGE_PATH_NOT_EXPORTED，必须运行时动态 import。
 */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdkPromise: Promise<PiSdk> | null = null;
function getSdk(): Promise<PiSdk> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}
import type {
	PiImagePlaceholder,
	PiMessage,
	PiSessionContextPage,
	PiSessionDetail,
	PiSessionInfo,
	PiSessionTreeNode,
	PiTextContent,
	PiThinkingPlaceholder,
	PiToolCallContent,
} from "@vcpdeck/shared";
import { textOf, truncatePreview } from "./normalize.js";

/** 单页消息条数（最新窗口） */
export const PI_CONTEXT_PAGE_SIZE = 60;
/** 投影树最大深度 */
const MAX_PROJECTED_TREE_DEPTH = 200;
/** Tool Result 文本超过该长度时延迟加载 */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function pathKey(p: string): string {
	const s = normalize(p).replace(/\\/g, "/");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface PiSessionReader {
	list(): Promise<PiSessionInfo[]>;
	newSession(): Promise<{ sessionId: string }>;
	get(sessionId: string): Promise<PiSessionDetail>;
	context(
		sessionId: string,
		leafId?: string | null,
		cursor?: string | null,
	): Promise<PiSessionContextPage>;
	entryContent(
		sessionId: string,
		entryId: string,
		blockIndex: number,
	): Promise<{ mimeType: string; data: string }>;
	rename(sessionId: string, name: string): Promise<void>;
	delete(sessionId: string): Promise<void>;
	fork(
		sessionId: string,
		upToMessageId: string,
	): Promise<{ sessionId: string }>;
	clone(sessionId: string): Promise<{ sessionId: string }>;
	navigate(sessionId: string, leafId: string): Promise<PiSessionContextPage>;
}

/** 按 canonical cwd 创建 Session 读取器（不创建 AgentSession、不加载 extensions） */
export function createPiSessionReader(
	cwd: string,
	sessionDir?: string,
): PiSessionReader {
	const pathCache = new Map<string, string>();
	let listCache: PiSessionInfo[] | null = null;

	async function loadList(): Promise<PiSessionInfo[]> {
		if (listCache) return listCache;
		const piSessions: PiSdkSessionInfo[] = await (
			await getSdk()
		).SessionManager.list(cwd, sessionDir);
		const pathToId = new Map<string, string>();
		for (const s of piSessions) pathToId.set(pathKey(s.path), s.id);
		const out: PiSessionInfo[] = [];
		for (const s of piSessions) {
			pathCache.set(s.id, s.path);
			out.push({
				id: s.id,
				name: s.name ?? "",
				created: String(s.created),
				modified: String(s.modified),
				messageCount: s.messageCount,
				firstMessage: truncatePreview(s.firstMessage),
				parentSessionId: s.parentSessionPath
					? (pathToId.get(pathKey(s.parentSessionPath)) ?? null)
					: null,
				running: false,
			});
		}
		listCache = out;
		return out;
	}

	async function resolvePath(sessionId: string): Promise<string> {
		const cached = pathCache.get(sessionId);
		if (cached) return cached;
		await loadList();
		const found = pathCache.get(sessionId);
		if (!found) throw piError("PI_SESSION_NOT_FOUND", "Session not found");
		return found;
	}

	function invalidateList(): void {
		listCache = null;
	}

	function sessionIdFromPath(p: string): string {
		const name = p.split(/[\\/]/).pop() ?? "";
		const match = /_([^_.]+)\.jsonl$/i.exec(name);
		return match?.[1] ?? "";
	}

	function imagePlaceholder(
		entryId: string,
		blockIndex: number,
		mimeType: string,
	): PiImagePlaceholder {
		return { type: "image", deferred: true, mimeType, entryId, blockIndex };
	}

	function entryToMessage(entry: SessionEntry): PiMessage | null {
		switch (entry.type) {
			case "message": {
				const msg = entry.message as unknown as {
					role?: string;
					content?: unknown;
					toolCallId?: string;
				};
				const role = msg.role ?? "user";
				const blocks = Array.isArray(msg.content) ? msg.content : [];
				if (role === "assistant") {
					const content = blocks
						.map((block, i) => {
							if (!isRecord(block)) return null;
							switch (block.type) {
								case "text":
									return {
										type: "text",
										text: String(block.text ?? ""),
									} satisfies PiTextContent;
								case "thinking": {
									const placeholder: PiThinkingPlaceholder = {
										type: "thinking",
										deferred: true,
									};
									if (typeof block.durationMs === "number")
										placeholder.durationMs = block.durationMs;
									return placeholder;
								}
								case "toolCall":
									return {
										type: "tool_call",
										toolCallId: String(block.id ?? ""),
										toolName: String(block.name ?? ""),
										input: isRecord(block.arguments) ? block.arguments : {},
									} satisfies PiToolCallContent;
								case "image":
									return imagePlaceholder(
										entry.id,
										i,
										String(block.mimeType ?? "image/png"),
									);
								default:
									return null;
							}
						})
						.filter((b): b is NonNullable<typeof b> => b !== null);
					return { id: entry.id, role: "assistant", content };
				}
				if (role === "toolResult") {
					const content: PiTextContent[] = [];
					let omittedImages = 0;
					for (const block of blocks) {
						if (!isRecord(block)) continue;
						if (block.type === "text") {
							const text = String(block.text ?? "");
							if (text.length > MAX_TOOL_RESULT_BYTES) {
								content.push({
									type: "text",
									text: `[Tool result truncated (${text.length} bytes); expand to load]`,
								});
							} else {
								content.push({ type: "text", text });
							}
						} else if (block.type === "image") {
							omittedImages += 1;
						}
					}
					if (omittedImages > 0) {
						content.push({
							type: "text",
							text: `[${omittedImages} tool result image${omittedImages === 1 ? "" : "s"} omitted from initial history]`,
						});
					}
					return {
						id: entry.id,
						role: "tool_result",
						toolCallId: String(msg.toolCallId ?? ""),
						content,
					};
				}
				if (role === "user") {
					const content = blocks
						.map((block, i) => {
							if (!isRecord(block)) return null;
							if (block.type === "text") {
								return {
									type: "text",
									text: String(block.text ?? ""),
								} satisfies PiTextContent;
							}
							if (block.type === "image") {
								return imagePlaceholder(
									entry.id,
									i,
									String(block.mimeType ?? "image/png"),
								);
							}
							return null;
						})
						.filter((b): b is PiTextContent | PiImagePlaceholder => b !== null);
					return { id: entry.id, role: "user", content };
				}
				// bashExecution 等其它角色 → 自定义消息
				return { id: entry.id, role: "custom", kind: String(role) };
			}
			case "compaction":
				return {
					id: entry.id,
					role: "custom",
					kind: "compaction",
				};
			case "custom_message":
				return {
					id: entry.id,
					role: "custom",
					kind: String(
						(entry as unknown as { customType?: string }).customType ??
							"custom",
					),
				};
			default:
				return null;
		}
	}

	async function buildContext(
		sessionId: string,
		leafId?: string | null,
		cursor?: string | null,
	): Promise<{ messages: PiMessage[]; nextCursor: string | null }> {
		const path = await resolvePath(sessionId);
		const sm = (await getSdk()).SessionManager.open(path);
		const entries = sm.getEntries() as unknown as SessionEntry[];
		const byId = new Map<string, SessionEntry>();
		for (const e of entries) byId.set(e.id, e);
		const selected = (await getSdk()).buildContextEntries(
			entries,
			leafId ?? sm.getLeafId(),
			byId,
		);
		const all: PiMessage[] = [];
		for (const entry of selected) {
			const m = entryToMessage(entry);
			if (m) all.push(m);
		}
		if (cursor) {
			const idx = all.findIndex((m) => m.id === cursor);
			if (idx === -1)
				throw piError("PI_SESSION_NOT_FOUND", "Cursor entry not found");
			const start = Math.max(0, idx - PI_CONTEXT_PAGE_SIZE);
			const window = all.slice(start, idx);
			return {
				messages: window,
				nextCursor: start > 0 ? (all[start]?.id ?? null) : null,
			};
		}
		const start = Math.max(0, all.length - PI_CONTEXT_PAGE_SIZE);
		const window = all.slice(start);
		return {
			messages: window,
			nextCursor: start > 0 ? (all[start]?.id ?? null) : null,
		};
	}

	return {
		async list() {
			return loadList();
		},
		async newSession() {
			const manager = (await getSdk()).SessionManager.create(cwd, sessionDir);
			const sessionFile = manager.getSessionFile();
			const header = manager.getHeader();
			if (!sessionFile || !header) {
				throw piError("PI_RUNTIME_UNAVAILABLE", "Failed to create Session");
			}
			await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
			const sessionId = manager.getSessionId();
			pathCache.set(sessionId, sessionFile);
			invalidateList();
			return { sessionId };
		},
		async get(sessionId) {
			const path = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(path);
			const header = sm.getHeader();
			const leafId = sm.getLeafId();
			const tree = sm.getTree() as unknown as Array<{
				entry: { id: string; type: string };
				children: unknown[];
			}>;
			const projected = projectTree(tree, leafId);
			const { messages } = await buildContext(sessionId, leafId);
			return {
				info: {
					id: sessionId,
					name: sm.getSessionName() ?? "",
					created: header?.timestamp ?? new Date().toISOString(),
					modified: header?.timestamp ?? new Date().toISOString(),
					messageCount: messages.length,
					firstMessage: truncatePreview(
						textOf(messages.find((m) => m.role === "user")?.content),
					),
					parentSessionId: header?.parentSession
						? sessionIdFromPath(header.parentSession) || null
						: null,
					running: false,
				},
				tree: projected,
				activeLeafId: leafId,
			};
		},
		async context(sessionId, leafId, cursor) {
			return buildContext(sessionId, leafId ?? undefined, cursor ?? undefined);
		},
		async entryContent(sessionId, entryId, blockIndex) {
			const path = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(path);
			const entry = sm.getEntry(entryId);
			if (!entry || entry.type !== "message") {
				throw piError("PI_SESSION_NOT_FOUND", "Entry not found");
			}
			const content = (entry.message as unknown as { content?: unknown })
				.content;
			if (!Array.isArray(content) || !isRecord(content[blockIndex])) {
				throw piError("PI_IMAGE_INVALID", "Block is not an image");
			}
			const block = content[blockIndex];
			if (block.type !== "image" || typeof block.data !== "string") {
				throw piError("PI_IMAGE_INVALID", "Block is not an image");
			}
			return {
				mimeType: String(block.mimeType ?? "image/png"),
				data: block.data,
			};
		},
		async rename(sessionId, name) {
			const trimmed = name.trim();
			if (!trimmed)
				throw piError("PI_PROTOCOL_INVALID", "Session name must not be empty");
			const path = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(path);
			sm.appendSessionInfo(trimmed);
			invalidateList();
		},
		async delete(sessionId) {
			const path = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(path);
			const parentSessionPath = sm.getHeader()?.parentSession ?? null;
			const dir = dirname(path);
			const targetKey = pathKey(path);
			let files: string[] = [];
			try {
				files = await readdir(dir);
			} catch {
				// 目录不可读时跳过 re-parent
			}
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const childPath = join(dir, file);
				if (pathKey(childPath) === targetKey) continue;
				try {
					const content = await readFile(childPath, "utf8");
					const lines = content.split("\n");
					const header = JSON.parse(lines[0] ?? "null") as {
						type?: string;
						parentSession?: string;
					};
					if (
						header.type === "session" &&
						header.parentSession &&
						pathKey(header.parentSession) === targetKey
					) {
						header.parentSession = parentSessionPath ?? undefined;
						lines[0] = JSON.stringify(header);
						const tmp = `${childPath}.vcpdeck-reparent-${randomUUID()}`;
						await writeFile(tmp, lines.join("\n"), "utf8");
						await rename(tmp, childPath);
					}
				} catch {
					// 跳过损坏文件
				}
			}
			await unlink(path).catch(() => {});
			pathCache.delete(sessionId);
			invalidateList();
		},
		async fork(sessionId, upToMessageId) {
			const sourcePath = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(sourcePath);
			const targetCwd = sm.getCwd() || cwd;
			const dir = sm.getSessionDir();
			const entries = sm.getEntries() as unknown as SessionEntry[];
			const target = entries.find((e) => e.id === upToMessageId);
			if (!target) throw piError("PI_SESSION_NOT_FOUND", "Message not found");
			const byId = new Map<string, SessionEntry>();
			for (const e of entries) byId.set(e.id, e);
			const chain: SessionEntry[] = [];
			let cur: SessionEntry | null = target;
			while (cur) {
				chain.unshift(cur);
				cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null;
			}
			const newSessionId = randomUUID();
			const timestamp = new Date().toISOString();
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const newPath = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);
			const lines: string[] = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: newSessionId,
					timestamp,
					cwd: targetCwd,
					parentSession: sourcePath,
				}),
			];
			for (const e of chain) lines.push(JSON.stringify(e));
			await writeFile(newPath, `${lines.join("\n")}\n`, "utf8");
			pathCache.set(newSessionId, newPath);
			invalidateList();
			return { sessionId: newSessionId };
		},
		async clone(sessionId) {
			const path = await resolvePath(sessionId);
			const sm = (await getSdk()).SessionManager.open(path);
			const leafId = sm.getLeafId();
			if (!leafId) throw piError("PI_SESSION_NOT_FOUND", "Session has no leaf");
			const newPath = sm.createBranchedSession(leafId);
			if (!newPath) throw piError("PI_SESSION_NOT_FOUND", "Clone failed");
			const newSessionId = sessionIdFromPath(newPath);
			pathCache.set(newSessionId, newPath);
			invalidateList();
			return { sessionId: newSessionId };
		},
		async navigate(sessionId, leafId) {
			return buildContext(sessionId, leafId);
		},
	};
}

/** 迭代式树投影：保留根、分支点与叶子，压缩单链；最大深度 200 */
function projectTree(
	nodes: Array<{ entry: { id: string; type: string }; children: unknown[] }>,
	leafId: string | null,
): PiSessionTreeNode[] {
	const toNode = (
		n: { entry: { id: string; type: string }; children: unknown[] },
		depth: number,
	): PiSessionTreeNode | null => {
		const children = (n.children ?? []) as Array<{
			entry: { id: string; type: string };
			children: unknown[];
		}>;
		const projectedChildren: PiSessionTreeNode[] = [];
		for (const child of children) {
			if (depth >= MAX_PROJECTED_TREE_DEPTH) break;
			const c = toNode(child, depth + 1);
			if (c) projectedChildren.push(c);
		}
		return {
			id: n.entry.id,
			name: "",
			messageCount: 0,
			running: leafId === n.entry.id,
			children: projectedChildren,
		};
	};
	return nodes
		.map((n) => toNode(n, 1))
		.filter((n): n is PiSessionTreeNode => n !== null);
}
