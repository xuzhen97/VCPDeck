"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageObjectNotFoundError = void 0;
/** Provider 明确确认对象不存在时使用的错误。 */
class StorageObjectNotFoundError extends Error {
    constructor() {
        super("Storage object not found");
        this.name = "StorageObjectNotFoundError";
    }
}
exports.StorageObjectNotFoundError = StorageObjectNotFoundError;
