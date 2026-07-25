import { Injectable, Inject, Logger, type OnModuleInit } from "@nestjs/common";
import { FileService } from "./file.service.js";

@Injectable()
export class FileCleanupService implements OnModuleInit {
	private readonly logger = new Logger(FileCleanupService.name);
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		@Inject(FileService) private readonly fileService: FileService,
	) {}

	onModuleInit() {
		this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
		this.logger.log("File cleanup scheduler started (every 10min)");
	}

	private async cleanup() {
		try {
			const expired = await this.fileService.getExpiredFiles();
			for (const f of expired) {
				await this.fileService.delete(f.id);
			}
			if (expired.length > 0) {
				this.logger.log(`Cleaned up ${expired.length} expired file(s)`);
			}
		} catch (err) {
			this.logger.warn("File cleanup error", err);
		}
	}
}
