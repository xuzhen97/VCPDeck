/**
 * Server 结构化运行日志的最小写入点。
 *
 * 单行 JSON（JSONL）：`ts` 在前，其余字段按调用方给出的顺序追加，便于
 * `grep '"jobId":"<id>"'` 还原一条 Job 链路，也便于外部采集器直接解析。
 * 只写 stdout；失败静默（日志本身绝不能影响业务）。
 */
export function writeLogLine(entry: Record<string, unknown>): void {
	try {
		process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// JSON 序列化失败（循环引用等）不应影响调用方
	}
}
