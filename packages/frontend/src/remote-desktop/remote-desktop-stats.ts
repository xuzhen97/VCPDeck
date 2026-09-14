/**
 * 从 `RTCPeerConnection.getStats()` 报告中提取对操作者有意义的事实。
 *
 * 只做**如实投影**：解析不出来就返回 `unknown`，绝不根据视频尺寸或猜测
 * 编造路径、延迟或帧率。是否走中继直接影响延迟与带宽成本，必须如实告知。
 */

/** 媒体路径：直连 / 经 TURN 中继 / 无法判定。 */
export type RemoteDesktopPath = "direct" | "relay" | "unknown";

export interface RemoteDesktopConnectionStats {
	path: RemoteDesktopPath;
	localCandidateType: string | null;
	remoteCandidateType: string | null;
	roundTripTimeMs: number | null;
	availableOutgoingBitrate: number | null;
	framesPerSecond: number | null;
}

const UNKNOWN: RemoteDesktopConnectionStats = {
	path: "unknown",
	localCandidateType: null,
	remoteCandidateType: null,
	roundTripTimeMs: null,
	availableOutgoingBitrate: null,
	framesPerSecond: null,
};

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function candidateTypeOf(
	byId: Map<string, Record<string, unknown>>,
	id: unknown,
): string | null {
	if (typeof id !== "string") return null;
	const type = byId.get(id)?.candidateType;
	return typeof type === "string" && type.length > 0 ? type : null;
}

/**
 * 归纳一份 stats 报告。
 *
 * 只认 `transport.selectedCandidatePairId` 指向的这一对候选，并要求其
 * `state === "succeeded"`：没有选中候选对时返回 `unknown`，不拿“看起来像”
 * 的候选对顶替，否则会把中继连接误报成直连。
 */
export function summarizeConnectionStats(
	entries: Iterable<unknown>,
): RemoteDesktopConnectionStats {
	const byId = new Map<string, Record<string, unknown>>();
	let selectedPairId: string | null = null;
	let framesPerSecond: number | null = null;

	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		switch (record.type) {
			case "transport": {
				const id = record.selectedCandidatePairId;
				if (selectedPairId === null && typeof id === "string" && id.length > 0) {
					selectedPairId = id;
				}
				break;
			}
			case "candidate-pair":
			case "local-candidate":
			case "remote-candidate": {
				// 候选与候选对都按 id 索引，供后续解析类型与延迟。
				if (typeof record.id === "string") byId.set(record.id, record);
				break;
			}
			case "inbound-rtp": {
				if (record.kind === "video" && framesPerSecond === null) {
					framesPerSecond = finiteNumber(record.framesPerSecond);
				}
				break;
			}
			default:
				break;
		}
	}

	const pair = selectedPairId === null ? undefined : byId.get(selectedPairId);
	if (!pair || pair.state !== "succeeded") {
		return { ...UNKNOWN, framesPerSecond };
	}

	const localCandidateType = candidateTypeOf(byId, pair.localCandidateId);
	const remoteCandidateType = candidateTypeOf(byId, pair.remoteCandidateId);
	// 任一端是 relay，媒体就必须经过 TURN 中继。
	const path: RemoteDesktopPath =
		localCandidateType === "relay" || remoteCandidateType === "relay" ? "relay" : "direct";
	const roundTripSeconds = finiteNumber(pair.currentRoundTripTime);

	return {
		path,
		localCandidateType,
		remoteCandidateType,
		roundTripTimeMs: roundTripSeconds === null ? null : Math.round(roundTripSeconds * 1000),
		availableOutgoingBitrate: finiteNumber(pair.availableOutgoingBitrate),
		framesPerSecond,
	};
}
