import { parsePiAgentState, } from "@vcpdeck/shared";
function cwdQuery(cwdRef) {
    const params = new URLSearchParams();
    params.set("rootDir", cwdRef.rootDir);
    params.set("relativePath", cwdRef.relativePath);
    return params.toString();
}
function enc(s) {
    return encodeURIComponent(s);
}
/** 创建远程 Pi REST API（机器命名空间） */
export function createPiApi(client) {
    return {
        capability: (clientId, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/capability`, undefined, signal),
        models: (clientId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/models?${cwdQuery(cwdRef)}`, undefined, signal),
        sessions: {
            list: (clientId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions?${cwdQuery(cwdRef)}`, undefined, signal),
            get: (clientId, sessionId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}?${cwdQuery(cwdRef)}`, undefined, signal),
            context: (clientId, sessionId, cwdRef, options, signal) => {
                const params = new URLSearchParams(cwdQuery(cwdRef));
                if (options?.leafId)
                    params.set("leafId", options.leafId);
                if (options?.cursor)
                    params.set("cursor", options.cursor);
                return client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/context?${params.toString()}`, undefined, signal);
            },
            entryContent: (clientId, sessionId, entryId, cwdRef, blockIndex, signal) => {
                const params = new URLSearchParams(cwdQuery(cwdRef));
                params.set("blockIndex", String(blockIndex));
                return client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/entries/${enc(entryId)}/content?${params.toString()}`, undefined, signal);
            },
            rename: (clientId, sessionId, cwdRef, name) => client.request("PATCH", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
                ...cwdRef,
                name,
            }),
            delete: (clientId, sessionId, cwdRef) => client.request("DELETE", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
                ...cwdRef,
            }),
            fork: (clientId, sessionId, cwdRef, messageId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/fork`, {
                ...cwdRef,
                messageId,
            }),
            clone: (clientId, sessionId, cwdRef) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/clone`, {
                ...cwdRef,
            }),
            navigate: (clientId, sessionId, cwdRef, targetId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/navigate`, {
                ...cwdRef,
                targetId,
            }),
        },
        agent: {
            newSession: (clientId, cwdRef, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/new`, { ...cwdRef }, signal),
            open: (clientId, sessionId, cwdRef, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/open`, cwdRef, signal),
            complete: (clientId, sessionId, runId, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/complete`, runId === undefined ? {} : { runId }, signal),
            state: async (clientId, sessionId, cwdRef, signal) => parsePiAgentState(await client.request("GET", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}?${cwdQuery(cwdRef)}`, undefined, signal)),
            prompt: (clientId, sessionId, cwdRef, input, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}`, {
                ...cwdRef,
                type: "prompt",
                submissionId: input.submissionId,
                prompt: input.prompt,
                ...(input.images?.length ? { images: input.images } : {}),
            }, signal),
            steer: (clientId, sessionId, runId, message) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/steer`, {
                runId,
                message,
            }),
            followUp: (clientId, sessionId, runId, message) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/follow-up`, {
                runId,
                message,
            }),
            abort: (clientId, sessionId, runId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort`, {
                runId,
            }),
            compact: (clientId, sessionId, runId, customInstructions) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/compact`, {
                runId,
                ...(customInstructions ? { customInstructions } : {}),
            }),
            abortCompact: (clientId, sessionId, runId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort-compact`, {
                runId,
            }),
            setModel: (clientId, sessionId, cwdRef, provider, modelId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/model`, {
                ...cwdRef,
                provider,
                modelId,
            }),
            setThinking: (clientId, sessionId, cwdRef, level) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/thinking`, {
                ...cwdRef,
                level,
            }),
            extensionResponse: (clientId, sessionId, runId, response) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/extension-response`, { runId, ...response }),
            eventsPath: (clientId, sessionId) => `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/events`,
        },
        attachments: {
            create: (clientId, images, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/attachments`, { images }, signal),
            complete: (clientId, attachmentId, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}/complete`, undefined, signal),
            delete: (clientId, attachmentId) => client.request("DELETE", `/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}`),
        },
        running: (clientId, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/running`, undefined, signal),
    };
}
