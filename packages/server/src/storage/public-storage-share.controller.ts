import {
	BadGatewayException,
	Controller,
	HttpException,
	Inject,
	NotFoundException,
	Param,
	Get,
	Res,
	GoneException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { StorageObjectNotFoundError } from "./providers/storage-provider.interface.js";
import { previewMime, StorageShareService } from "./storage-share.service.js";
import { StorageService } from "./storage.service.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function safeFilename(value: string): string {
	return value.replace(/[\r\n]/g, "").replace(/\\/g, "_").replace(/"/g, "'");
}

function disposition(filename: string): string {
	return `inline; filename*=UTF-8''${encodeURIComponent(safeFilename(filename))}`;
}

function publicError(status: number, message: string): HttpException {
	if (status === 404) return new NotFoundException({ code: "NOT_FOUND", message });
	if (status === 410) return new GoneException({ code: "GONE", message });
	if (status === 503) {
		return new ServiceUnavailableException({ code: "UNAVAILABLE", message });
	}
	return new BadGatewayException({ code: "STORAGE_UNAVAILABLE", message });
}

@Controller("api/public/storage-shares")
export class PublicStorageShareController {
	constructor(
		@Inject(StorageShareService) private readonly shares: StorageShareService,
		@Inject(StorageService) private readonly storage: StorageService,
	) {}

	/** 无认证公开读取分享文件。 */
	@Public()
	@Get(":token")
	async download(@Param("token") token: string, @Res() response: Response): Promise<void> {
		if (!TOKEN_RE.test(token)) throw publicError(404, "Not found");

		let resolved: Awaited<ReturnType<StorageShareService["resolvePublic"]>>;
		try {
			resolved = await this.shares.resolvePublic(token);
		} catch (error) {
			throw this.mapPublicError(error);
		}

		const file = resolved.file;
		if (!file || resolved.revokedAt || resolved.invalidatedAt) {
			throw publicError(410, "Share is no longer available");
		}
		if (file.status !== "completed") throw publicError(404, "Not found");
		if (file.storageKind !== this.storage.currentKind()) {
			throw publicError(503, "Storage is temporarily unavailable");
		}

		const filename = resolved.filename ?? file.filename;
		const mime = previewMime(filename);
		try {
			if (mime) {
				const { stream, meta } = await this.storage.openDownload(file.key);
				response.setHeader("Content-Type", mime);
				response.setHeader("Content-Disposition", disposition(filename));
				response.setHeader("X-Content-Type-Options", "nosniff");
				response.setHeader("Referrer-Policy", "no-referrer");
				response.setHeader("Cache-Control", "private, no-store");
				if (mime === "image/svg+xml") {
					response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:");
				}
				if (Number.isFinite(meta.size) && meta.size > 0) response.setHeader("Content-Length", meta.size);
				stream.on("error", () => response.destroy());
				stream.pipe(response);
				return;
			}

			const ref = await this.storage.createDownloadToken(file.key);
			response.status(302);
			response.setHeader("Location", ref.url);
			response.setHeader("Referrer-Policy", "no-referrer");
			response.setHeader("Cache-Control", "private, no-store");
			response.end();
		} catch (error) {
			if (error instanceof StorageObjectNotFoundError) {
				await this.shares.markInvalid(resolved.id, "OBJECT_NOT_FOUND");
				throw publicError(410, "Share is no longer available");
			}
			throw publicError(502, "Storage is temporarily unavailable");
		}
	}

	private mapPublicError(error: unknown): HttpException {
		const status = (error as { statusCode?: unknown }).statusCode;
		if (status === 404) return publicError(404, "Not found");
		if (status === 410) return publicError(410, "Share is no longer available");
		return publicError(502, "Storage is temporarily unavailable");
	}
}
