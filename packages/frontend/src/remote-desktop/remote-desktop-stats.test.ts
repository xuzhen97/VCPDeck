import { describe, expect, it } from "vitest";
import { summarizeConnectionStats } from "./remote-desktop-stats.js";

/** 构造一份与 getStats() 形状一致的报告条目集合。 */
function report(overrides: {
	localType?: string;
	remoteType?: string;
	roundTripTime?: number;
	bitrate?: number;
	fps?: number;
	selectedPairId?: string | null;
} = {}) {
	const {
		localType = "host",
		remoteType = "srflx",
		roundTripTime = 0.03,
		bitrate = 2_000_000,
		fps = 30,
		selectedPairId = "CP1",
	} = overrides;
	const entries: Record<string, unknown>[] = [
		{
			type: "transport",
			...(selectedPairId ? { selectedCandidatePairId: selectedPairId } : {}),
		},
		{
			type: "candidate-pair",
			id: "CP1",
			state: "succeeded",
			nominated: true,
			localCandidateId: "L1",
			remoteCandidateId: "R1",
			currentRoundTripTime: roundTripTime,
			availableOutgoingBitrate: bitrate,
		},
		{ type: "local-candidate", id: "L1", candidateType: localType },
		{ type: "remote-candidate", id: "R1", candidateType: remoteType },
		{ type: "inbound-rtp", kind: "video", framesPerSecond: fps },
	];
	return entries;
}

describe("summarizeConnectionStats", () => {
	it("reports a direct path when neither candidate is relayed", () => {
		const stats = summarizeConnectionStats(report());
		expect(stats.path).toBe("direct");
		expect(stats.localCandidateType).toBe("host");
		expect(stats.remoteCandidateType).toBe("srflx");
		// 0.03 秒 → 30 毫秒
		expect(stats.roundTripTimeMs).toBe(30);
		expect(stats.availableOutgoingBitrate).toBe(2_000_000);
		expect(stats.framesPerSecond).toBe(30);
	});

	it("reports a relayed path when either side is a relay candidate", () => {
		// 只要有一端是 relay，媒体就走 TURN 中继，必须如实告知用户。
		expect(summarizeConnectionStats(report({ remoteType: "relay" })).path).toBe("relay");
		expect(summarizeConnectionStats(report({ localType: "relay" })).path).toBe("relay");
	});

	it("reports unknown when no candidate pair has been selected yet", () => {
		const stats = summarizeConnectionStats(report({ selectedPairId: null }));
		expect(stats.path).toBe("unknown");
		expect(stats.roundTripTimeMs).toBeNull();
		expect(stats.localCandidateType).toBeNull();
	});

	it("degrades to unknown for an empty or malformed report", () => {
		for (const entries of [[], [{ type: "transport" }], [{ nonsense: true }]]) {
			const stats = summarizeConnectionStats(entries);
			expect(stats.path).toBe("unknown");
			expect(stats.roundTripTimeMs).toBeNull();
			expect(stats.framesPerSecond).toBeNull();
		}
	});

	it("ignores a malformed candidate-pair instead of inventing numbers", () => {
		const entries: Record<string, unknown>[] = [
			{ type: "transport", selectedCandidatePairId: "CP1" },
			// state 不是 succeeded：不能当作可用路径。
			{ type: "candidate-pair", id: "CP1", state: "failed" },
		];
		const stats = summarizeConnectionStats(entries);
		expect(stats.path).toBe("unknown");
		expect(stats.roundTripTimeMs).toBeNull();
	});

	it("rounds sub-millisecond and non-finite values safely", () => {
		expect(
			summarizeConnectionStats(report({ roundTripTime: 0.0004 })).roundTripTimeMs,
		).toBe(0);
		expect(
			summarizeConnectionStats(report({ roundTripTime: Number.NaN })).roundTripTimeMs,
		).toBeNull();
		expect(
			summarizeConnectionStats(report({ fps: Number.POSITIVE_INFINITY })).framesPerSecond,
		).toBeNull();
	});
});
