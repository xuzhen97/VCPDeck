/**
 * 列出所有机器及其状态
 */
export async function handleListClients(client) {
    const clients = await client.clients.list();
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(clients, null, 2),
            },
        ],
        messageForAI: `成功获取机器列表，共 ${clients.length} 台机器。`,
    };
}
