export async function handleGetStorageStatus(client) {
    const status = await client.storage.getBackendConfig();
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(status, null, 2),
            },
        ],
        messageForAI: "存储后端状态查询成功。",
    };
}
