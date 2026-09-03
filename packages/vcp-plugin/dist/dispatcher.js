import { handleListClients } from "./handlers/clients.js";
import { handleListJobs, handleGetJob, handleGetJobOutput, handleRunShellJob, handleCancelJob, } from "./handlers/jobs.js";
import { handleListRoots, handleListDirectory, handleStatFile, handleReadFile, handleWriteFile, handleMakeDirectory, handleDeleteFile, handleMoveFile, } from "./handlers/files.js";
import { handleListFrpInstances, handleListFrpMappings, handleGetFrpMapping, handleCreateFrpMapping, handleDeleteFrpMapping, } from "./handlers/frp.js";
import { handleGetStorageStatus } from "./handlers/storage.js";
import { handleListReleases } from "./handlers/releases.js";
/**
 * 分发执行 VCP 指令
 */
export async function dispatchCommand(client, req) {
    const command = req.command;
    const params = req.params || {};
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
