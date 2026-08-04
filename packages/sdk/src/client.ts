import { createAliyunDriveApi } from "./aliyundrive.js";
import { createAuthApi, createIdentitiesApi } from "./auth.js";
import { createClientsApi } from "./clients.js";
import { createFilesApi } from "./files.js";
import { createFrpApi } from "./frp.js";
import { createJobsApi } from "./jobs.js";
import { createStorageApi } from "./storage.js";

export type AuthMode = { type: "cookie" } | { type: "bearer"; token: string };

/** VCPDeck 客户端配置。 */
export interface VcpDeckClientOptions {
	baseUrl: string;
	auth: AuthMode;
	fetch?: typeof globalThis.fetch;
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
	}

	/** 发起 REST 请求并归一化失败响应。 */
	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.baseUrl}${path}`, {
				method,
				signal,
				credentials:
					this.options.auth.type === "cookie" ? "include" : undefined,
				headers: {
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
					...(this.options.auth.type === "bearer"
						? { Authorization: `Bearer ${this.options.auth.token}` }
						: {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			if (signal?.aborted) throw error;
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
		return parsed as T;
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
