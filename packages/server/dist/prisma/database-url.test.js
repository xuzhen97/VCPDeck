"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
const vitest_1 = require("vitest");
const database_url_js_1 = require("./database-url.js");
(0, vitest_1.describe)("resolveDatabaseUrl", () => {
    (0, vitest_1.it)("returns the explicit database URL unchanged", () => {
        (0, vitest_1.expect)((0, database_url_js_1.resolveDatabaseUrl)("file:C:/Temp/vcpdeck/test.db", "D:/repo/server")).toBe("file:C:/Temp/vcpdeck/test.db");
    });
    (0, vitest_1.it)("maps the legacy development URL to the Prisma development database", () => {
        const cwd = path.resolve("test-server");
        (0, vitest_1.expect)((0, database_url_js_1.resolveDatabaseUrl)("file:./dev.db", cwd)).toBe((0, node_url_1.pathToFileURL)(path.join(cwd, "prisma", "dev.db")).href);
    });
    (0, vitest_1.it)("documents the canonical development database URL", () => {
        (0, vitest_1.expect)((0, node_fs_1.readFileSync)(path.resolve(".env.example"), "utf8")).toContain('DATABASE_URL="file:./prisma/dev.db"');
    });
    vitest_1.it.each([
        undefined,
        "",
    ])("defaults to the server development database for %j", (databaseUrl) => {
        const cwd = path.resolve("test-server");
        (0, vitest_1.expect)((0, database_url_js_1.resolveDatabaseUrl)(databaseUrl, cwd)).toBe((0, node_url_1.pathToFileURL)(path.join(cwd, "prisma", "dev.db")).href);
    });
});
