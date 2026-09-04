import { handleListClients } from "./handlers/clients.js";
import { handleListJobs, handleGetJob, handleGetJobOutput, handleRunShellJob, handleCancelJob, } from "./handlers/jobs.js";
import { handleListRoots, handleListDirectory, handleStatFile, handleReadFile, handleWriteFile, handleMakeDirectory, handleDeleteFile, handleMoveFile, } from "./handlers/files.js";
import { handleListFrpInstances, handleListFrpMappings, handleGetFrpMapping, handleCreateFrpMapping, handleDeleteFrpMapping, } from "./handlers/frp.js";
import { handleGetStorageStatus } from "./handlers/storage.js";
import { handleListReleases } from "./handlers/releases.js";
/** 21 个动作标识符的唯一清单（导出，供 manifest 测试引用） */
export const VCP_COMMANDS = [
    "ListClients",
    "ListJobs",
    "GetJob",
    "GetJobOutput",
    "RunShellJob",
    "CancelJob",
    "ListRoots",
    "ListDirectory",
    "StatFile",
    "ReadFile",
    "WriteFile",
    "MakeDirectory",
    "DeleteFile",
    "MoveFile",
    "ListFrpInstances",
    "ListFrpMappings",
    "GetFrpMapping",
    "CreateFrpMapping",
    "DeleteFrpMapping",
    "GetStorageStatus",
    "ListReleases",
];
/**
 * 分发执行 VCP 指令
 */
export async function dispatchCommand(client, req) {
    const { command, params: _nested, maid: _maid, ...flat } = req;
    const params = { ...flat, ...(_nested ?? {}) };
    switch (command) {
        case "ListClients":
            return handleListClients(client);
        case "ListJobs":
            return handleListJobs(client, params);
        case "GetJob":
            return handleGetJob(client, params);
        case "GetJobOutput":
            return handleGetJobOutput(client, params);
        case "RunShellJob":
            return handleRunShellJob(client, params);
        case "CancelJob":
            return handleCancelJob(client, params);
        case "ListRoots":
            return handleListRoots(client, params);
        case "ListDirectory":
            return handleListDirectory(client, params);
        case "StatFile":
            return handleStatFile(client, params);
        case "ReadFile":
            return handleReadFile(client, params);
        case "WriteFile":
            return handleWriteFile(client, params);
        case "MakeDirectory":
            return handleMakeDirectory(client, params);
        case "DeleteFile":
            return handleDeleteFile(client, params);
        case "MoveFile":
            return handleMoveFile(client, params);
        case "ListFrpInstances":
            return handleListFrpInstances(client, params);
        case "ListFrpMappings":
            return handleListFrpMappings(client, params);
        case "GetFrpMapping":
            return handleGetFrpMapping(client, params);
        case "CreateFrpMapping":
            return handleCreateFrpMapping(client, params);
        case "DeleteFrpMapping":
            return handleDeleteFrpMapping(client, params);
        case "GetStorageStatus":
            return handleGetStorageStatus(client);
        case "ListReleases":
            return handleListReleases(client, params);
        default:
            throw new Error(`Unknown command identifier: "${command}"`);
    }
}
