import type { PiAttachmentDescriptor } from "@vcpdeck/shared";
/** 校验单图字节（真实大小/魔数/MIME 一致性） */
export declare function validateImageBytes(bytes: Buffer, declared: PiAttachmentDescriptor): void;
export interface PiDownloadedImage {
    bytes: Buffer;
    ref: PiAttachmentDescriptor;
}
/**
 * 下载并校验 prompt 附件（Content-Length + 真实 bytes 双上限、
 * declared size/hash/MIME、魔数、禁 redirect 跟随）。
 * 任何失败清空全部 buffer 并抛稳定错误。
 */
export declare function downloadPromptImages(refs: PiAttachmentDescriptor[]): Promise<PiDownloadedImage[]>;
/** 转为 Pi SDK image content（base64） */
export declare function toSdkImages(images: PiDownloadedImage[]): Array<{
    type: "image";
    data: string;
    mimeType: string;
}>;
