import {
	Controller,
	Delete,
	HttpException,
	Inject,
	Param,
} from "@nestjs/common";
import { FileService } from "./file.service.js";
import { StorageService } from "../storage/storage.service.js";

/** 受控 Storage 删除入口：已登记 File 必须经过 FileService 保留锁。 */
@Controller("api/storage/raw")
export class StorageDeleteController {
	constructor(
		@Inject(FileService) private readonly files: FileService,
		@Inject(StorageService) private readonly storage: StorageService,
	) {}

	@Delete(":key(*)")
	async delete(@Param("key") key: string) {
		try {
			const file = await this.files.findByKey(key);
			if (file) {
				await this.files.delete(file.id);
			} else {
				await this.storage.delete(key);
			}
			return { ok: true };
		} catch (error) {
			const failure = error as {
				code?: string;
				message?: string;
				statusCode?: number;
			};
			if (failure.statusCode) {
				throw new HttpException(
					{ code: failure.code, message: failure.message },
					failure.statusCode,
				);
			}
			throw new HttpException(
				{ code: "STORAGE_DELETE_FAILED", message: "Storage delete failed" },
				500,
			);
		}
	}
}
