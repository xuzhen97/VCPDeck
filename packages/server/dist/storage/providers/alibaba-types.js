"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PARTS = exports.DEFAULT_PART_SIZE = exports.MIN_PART_SIZE = exports.DEFAULT_TRANSFER_FOLDER = exports.DEFAULT_OPENAPI_BASE = void 0;
exports.DEFAULT_OPENAPI_BASE = "https://openapi.alipan.com";
exports.DEFAULT_TRANSFER_FOLDER = "VCPDeckTransfers";
exports.MIN_PART_SIZE = 8 * 1024 * 1024; // 阿里云盘最小分片 8MB
exports.DEFAULT_PART_SIZE = 64 * 1024 * 1024; // 默认 64MB
exports.MAX_PARTS = 10000;
