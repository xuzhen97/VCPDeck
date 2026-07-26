/** 阿里云盘存储配置（存入 StorageBackendConfig.config JSON） */
export interface AlibabaStorageConfig {
	/** 阿里云盘应用 client_id */
	clientId: string;
	/** 应用密钥（可选，用于 OAuth） */
	clientSecret?: string;
	/** OAuth refresh_token */
	refreshToken?: string;
	/** 当前 access_token（运行时刷新后会更新） */
	accessToken?: string;
	/** access_token 过期时间（epoch ms） */
	expiresAt?: number;
	/** 阿里云盘 drive_id（首次 getDriveInfo 后缓存） */
	driveId?: string;
	/** 中转文件夹名，默认 "VCPDeckTransfers" */
	transferFolder?: string;
	/** OpenAPI 基础 URL，默认 https://openapi.alipan.com */
	openapiBase?: string;
	/** 本地签名密钥（用于预签名 URL，auto-generated） */
	signSecret?: string;
}

export const DEFAULT_OPENAPI_BASE = "https://openapi.alipan.com";
export const DEFAULT_TRANSFER_FOLDER = "VCPDeckTransfers";
export const MIN_PART_SIZE = 8 * 1024 * 1024; // 阿里云盘最小分片 8MB
export const DEFAULT_PART_SIZE = 64 * 1024 * 1024; // 默认 64MB
export const MAX_PARTS = 10000;
