/**
 * 阿里云盘 OpenAPI 客户端
 *
 * 封装阿里云盘 OpenAPI 的 HTTP 调用，包括：
 * - 用户信息 / drive 查询
 * - 文件列表 / 创建目录
 * - 文件上传（create → getUploadUrl → complete）
 * - 文件下载 / 删除
 *
 * 参考：https://www.yuque.com/aliyundrive/zpfszx
 */

export interface AlibabaOpenApiClientOptions {
	openapiBase: string;
	accessToken: string;
	fetchImpl?: typeof fetch;
}

export class AlibabaOpenApiClient {
	private readonly base: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AlibabaOpenApiClientOptions) {
		this.base = options.openapiBase.replace(/\/+$/, "");
		this.token = options.accessToken;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async post<T = unknown>(path: string, payload: unknown): Promise<T> {
		const response = await this.fetchImpl(`${this.base}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`Aliyun OpenAPI failed: HTTP ${response.status} ${text.slice(0, 200)}`,
			);
		}
		return (await response.json()) as T;
	}

	/** 获取默认 drive 信息 */
	async getDriveInfo(): Promise<{ driveId: string; raw: unknown }> {
		const data = await this.post<Record<string, unknown>>(
			"/adrive/v1.0/user/getDriveInfo",
			{},
		);
		const driveId = String(
			data.default_drive_id ??
				data.defaultDriveId ??
				data.resource_drive_id ??
				data.resourceDriveId ??
				data.backup_drive_id ??
				data.backupDriveId ??
				"",
		);
		if (!driveId) throw new Error("Aliyun Drive 未返回 drive_id");
		return { driveId, raw: data };
	}

	/** 列目录 */
	async listChildren(input: {
		driveId: string;
		parentFileId: string;
		type?: "file" | "folder";
	}) {
		const payload: Record<string, unknown> = {
			drive_id: input.driveId,
			parent_file_id: input.parentFileId,
			limit: 100,
			order_by: "name",
			order_direction: "ASC",
		};
		if (input.type) payload.type = input.type;
		const data = await this.post<Record<string, unknown>>(
			"/adrive/v1.0/openFile/list",
			payload,
		);
		return (data.items ?? []) as Array<Record<string, unknown>>;
	}

	/** 创建目录 */
	async createFolder(input: {
		driveId: string;
		parentFileId: string;
		name: string;
	}) {
		return this.post<Record<string, unknown>>("/adrive/v1.0/openFile/create", {
			drive_id: input.driveId,
			parent_file_id: input.parentFileId,
			name: input.name,
			type: "folder",
			check_name_mode: "refuse",
		});
	}

	/**
	 * 确保目录路径存在，返回最终目录的 file_id
	 * ponytail: 每次调用都逐级查询/创建，不做缓存
	 */
	async ensureFolderPath(input: {
		driveId: string;
		folderPath: string;
	}): Promise<string> {
		const segments = input.folderPath
			.split(/[\\/]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		let parentFileId = "root";
		for (const segment of segments) {
			const children = await this.listChildren({
				driveId: input.driveId,
				parentFileId,
				type: "folder",
			});
			const matched = children.find(
				(item) => String(item.name ?? "") === segment,
			);
			if (matched) {
				parentFileId = String(matched.file_id ?? matched.fileId ?? "");
				if (!parentFileId)
					throw new Error(`Aliyun 目录 ${segment} 缺少 file_id`);
				continue;
			}
			const created = await this.createFolder({
				driveId: input.driveId,
				parentFileId,
				name: segment,
			});
			parentFileId = String(created.file_id ?? created.fileId ?? "");
			if (!parentFileId)
				throw new Error(`Aliyun 创建目录 ${segment} 未返回 file_id`);
		}
		return parentFileId;
	}

	/** 创建文件上传任务 */
	async createFileUpload(input: {
		driveId: string;
		parentFileId: string;
		name: string;
		size: number;
		partInfoList: Array<{ part_number: number }>;
	}) {
		return this.post<Record<string, unknown>>("/adrive/v1.0/openFile/create", {
			drive_id: input.driveId,
			parent_file_id: input.parentFileId,
			name: input.name,
			type: "file",
			check_name_mode: "auto_rename",
			size: input.size,
			part_info_list: input.partInfoList,
		});
	}

	/** 获取分片上传 URL */
	async getUploadUrl(input: {
		driveId: string;
		fileId: string;
		uploadId: string;
		partNumbers: number[];
	}) {
		return this.post<Record<string, unknown>>(
			"/adrive/v1.0/openFile/getUploadUrl",
			{
				drive_id: input.driveId,
				file_id: input.fileId,
				upload_id: input.uploadId,
				part_info_list: input.partNumbers.map((part_number) => ({
					part_number,
				})),
			},
		);
	}

	/** 完成上传（合并分片） */
	async completeUpload(input: {
		driveId: string;
		fileId: string;
		uploadId: string;
	}) {
		return this.post<Record<string, unknown>>(
			"/adrive/v1.0/openFile/complete",
			{
				drive_id: input.driveId,
				file_id: input.fileId,
				upload_id: input.uploadId,
			},
		);
	}

	/** 获取下载 URL */
	async getDownloadUrl(input: { driveId: string; fileId: string }) {
		return this.post<Record<string, unknown>>(
			"/adrive/v1.0/openFile/getDownloadUrl",
			{
				drive_id: input.driveId,
				file_id: input.fileId,
			},
		);
	}

	/** 删除文件 */
	async deleteFile(input: { driveId: string; fileId: string }) {
		return this.post<Record<string, unknown>>("/adrive/v1.0/openFile/delete", {
			drive_id: input.driveId,
			file_id: input.fileId,
		});
	}
}
