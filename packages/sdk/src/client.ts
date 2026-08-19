import { createAliyunDriveApi } from "./aliyundrive.js";
import { createAuthApi, createIdentitiesApi } from "./auth.js";
import { createClientsApi } from "./clients.js";
import { createFilesApi } from "./files.js";
import { createFrpApi } from "./frp.js";
import { createJobsApi } from "./jobs.js";
import { createPiApi } from "./pi.js";
import { createReleasesApi } from "./releases.js";
import { createStorageApi } from "./storage.js";
import { createTerminalsApi } from "./terminal.js";

/** SDK 认证模式；显式 cookie 仅用于不会自动维护 Cookie 的 Node.js 调用方。 */
export type AuthMode =
	| { type: "cookie"; cookie?: string }
	| { type: "bearer"; token: string };

/** VCPDeck 客户端配置。 */
export interface VcpDeckClientOptions {
	baseUrl: string;
	auth: AuthMode;
	fetch?: typeof globalThis.fetch;
}

/** 原始请求选项，用于 archive 等非 JSON 请求体。 */
export interface VcpDeckRawRequestOptions {
	body?: BodyInit;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/** Node.js 流式请求体必须声明为 half。 */
	duplex?: "half";
}

/** 带底层响应元数据的 SDK 返回值。 */
export interface VcpDeckResponse<T> {
	data: T;
	response: Response;
}

/** VCPDeck REST API 归一化错误。 */
export class VcpDeckApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "VcpDeckApiError";
	}
}

/** VCPDeck 框架无关 REST 客户端。 */
export class VcpDeckClient {
	private readonly fetcher: typeof globalThis.fetch;
	private readonly baseUrl: string;
	readonly jobs;
	readonly files;
	readonly auth;
	readonly identities;
	readonly clients;
	readonly storage;
	readonly aliyundrive;
	readonly frp;
	readonly pi;
	readonly releases;
	readonly terminals;
	readonly health = {
		get: (signal?: AbortSignal) =>
			this.request<{ ok: true }>("GET", "/api/health", undefined, signal),
	};

	constructor(private readonly options: VcpDeckClientOptions) {
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.jobs = createJobsApi(this);
		this.files = createFilesApi(this, this.jobs);
		this.auth = createAuthApi(this);
		this.identities = createIdentitiesApi(this);
		this.clients = createClientsApi(this);
		this.storage = createStorageApi(this);
		this.aliyundrive = createAliyunDriveApi(this);
		this.frp = createFrpApi(this);
		this.pi = createPiApi(this);
		this.releases = createReleasesApi(this);
		this.terminals = createTerminalsApi(this);
	}

	/** 发起 JSON REST 请求并归一化失败响应。 */
	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const result = await this.requestRaw<T>(method, path, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			signal,
		});
		return result.data;
	}

	/** 发起原始 body 请求，同时返回响应头供 Node.js 会话等协议使用。 */
	async requestRaw<T>(
		method: string,
		path: string,
		options: VcpDeckRawRequestOptions = {},
	): Promise<VcpDeckResponse<T>> {
		const headers: Record<string, string> = { ...options.headers };
		if (this.options.auth.type === "bearer") {
			headers.Authorization = `Bearer ${this.options.auth.token}`;
		} else if (this.options.auth.cookie) {
			headers.Cookie = this.options.auth.cookie;
		}

		let response: Response;
		try {
			response = await this.fetcher(`${this.baseUrl}${path}`, {
				method,
				signal: options.signal,
				credentials: this.options.auth.type === "cookie" ? "include" : undefined,
				headers,
				body: options.body,
				...(options.duplex ? { duplex: options.duplex } : {}),
			} as RequestInit);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new VcpDeckApiError("Network request failed", 0);
		}

		const text = await response.text();
		const parsed = text ? parseJson(text) : undefined;
		if (!response.ok) {
			const details = isRecord(parsed) ? parsed : undefined;
			const code = typeof details?.code === "string" ? details.code : undefined;
			const message =
				typeof details?.message === "string"
					? details.message
					: response.statusText || `HTTP ${response.status}`;
			throw new VcpDeckApiError(message, response.status, code, parsed);
		}
		return { data: parsed as T, response };
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
