/**
 * 发布构件直链缓存（ADR-0016）：
 * 外部存储直链临时有效（网盘约 15 分钟、OSS 预签名 TTL 自定），
 * 短时缓存避免每个下载请求都重新换取。
 * ponytail: 内存 Map，进程重启自然失效；过期由直链 expiresAt 驱动。
 */
const SAFETY_MARGIN_MS = 60_000;
/** 时间戳边界：小于该值视为秒（需换算为毫秒） */
const MS_EPOCH_BOUNDARY = 1e12;

interface DirectUrlEntry {
	url: string;
	/** 过期时间戳（ms；0=不设过期） */
	expiresAt: number;
}

export class DirectUrlCache {
	private readonly entries = new Map<string, DirectUrlEntry>();

	constructor(private readonly safetyMarginMs = SAFETY_MARGIN_MS) {}

	/** 命中且未到安全余量内返回 URL；否则淘汰并返回 null */
	get(key: string, now = Date.now()): string | null {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt > 0 && now + this.safetyMarginMs >= entry.expiresAt) {
			this.entries.delete(key);
			return null;
		}
		return entry.url;
	}

	set(key: string, url: string, expiresAt: number): void {
		// 部分后端以秒返回过期时间，统一换算为毫秒
		let expiry = expiresAt;
		if (expiry > 0 && expiry < MS_EPOCH_BOUNDARY) expiry *= 1000;
		this.entries.set(key, { url, expiresAt: expiry });
	}

	delete(key: string): void {
		this.entries.delete(key);
	}
}
