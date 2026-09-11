import { PrismaService } from "../prisma/prisma.service.js";
import { FileService } from "../file/file.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { PiAttachmentRef } from "@vcpdeck/shared";
export interface PiUploadImageInput {
    filename: string;
    size: number;
    mimeType: string;
}
/**
 * Pi 临时附件：Browser 上传到 Storage → FileRef → Client 校验 → prompt。
 * File row 用 purpose=pi_prompt/pi_history、jobId=null、15 分钟 TTL；
 * 不使用临时对象时由 TTL 清理（cleanup scheduler 复用）。
 */
export declare class PiAttachmentService {
    private readonly files;
    private readonly storage;
    private readonly prisma;
    constructor(files: FileService, storage: StorageService, prisma: PrismaService);
    /** 校验图片清单（数量/单图/总量/MIME） */
    private validateImages;
    /** 创建 prompt 附件上传会话（返回 PUT 令牌，未 complete 由 TTL 清理） */
    createPromptUploads(clientId: string, images: PiUploadImageInput[]): Promise<Array<{
        fileId: string;
        uploadUrl: string;
        expiresAt: number;
    }>>;
    /** complete 后返回给 Client 的 transient 描述符（Client 下载并校验 hash/mime/magic） */
    completePromptUpload(attachmentId: string, clientId: string): Promise<PiAttachmentRef>;
    /** 清理临时附件（prompt 拒绝/失败/取消时） */
    deleteAttachment(attachmentId: string, clientId: string): Promise<void>;
    /** 历史媒体三阶段第一步：Client 验证后创建 pi_history 上传会话 */
    prepareHistoryUpload(clientId: string, meta: PiUploadImageInput): Promise<{
        fileId: string;
        uploadUrl: string;
        expiresAt: number;
    }>;
    /** 历史媒体第三步：Client 上传完成，返回浏览器短期 GET ref */
    completeHistoryUpload(attachmentId: string, clientId: string): Promise<{
        url: string;
        expiresAt: number;
    }>;
}
