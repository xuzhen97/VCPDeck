import { type OnModuleInit } from "@nestjs/common";
import { FileService } from "./file.service.js";
export declare class FileCleanupService implements OnModuleInit {
    private readonly fileService;
    private readonly logger;
    private timer;
    constructor(fileService: FileService);
    onModuleInit(): void;
    private cleanup;
}
