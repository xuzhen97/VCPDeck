import { describe, expect, it } from "vitest";
import {
	FRP_RECONCILE_PROTOCOL_VERSION,
	parseFrpCapabilityStatus,
	parseFrpReconcilePayload,
	parseFrpRuntimeStateAck,
	parseFrpRuntimeStateReport,
} from "./index.js";

const mapping = {
	mappingId: "fm_1",
	name: "tcp-1919",
	proxyType: "tcp" as const,
	localIp: "127.0.0.1",
	localPort: 1919,
	remotePort: 20000,
	customDomain: null,
};

describe("FRP runtime protocol v1", () => {
	it("接受 protocol v1 capability 与无凭据 runtime state", () => {
		expect(parseFrpCapabilityStatus({ available: true, reconcileProtocolVersion: 1 })).toEqual({
			available: true,
			reconcileProtocolVersion: FRP_RECONCILE_PROTOCOL_VERSION,
		});
		expect(
			parseFrpRuntimeStateReport({
				clientId: "c1",
				connectionGeneration: "conn-1",
				runtimeGeneration: 3,
				status: "running",
				processRunning: true,
				recoveryOwner: null,
				attempt: 0,
				frpsEndpoint: { serverAddr: "frps.example.com", serverPort: 7000 },
				mappings: [mapping],
			}),
		).toMatchObject({ runtimeGeneration: 3, mappings: [mapping] });
	});

	it("拒绝未知字段、非法 generation 与 Client 上报凭据", () => {
		for (const value of [
			{
				clientId: "c1",
				connectionGeneration: "conn-1",
				runtimeGeneration: -1,
				status: "running",
				processRunning: true,
				recoveryOwner: null,
				attempt: 0,
				frpsEndpoint: null,
				mappings: [],
			},
			{
				clientId: "c1",
				connectionGeneration: "conn-1",
				runtimeGeneration: 0,
				status: "running",
				processRunning: true,
				recoveryOwner: null,
				attempt: 0,
				frpsEndpoint: null,
				mappings: [],
				authToken: "secret",
			},
		]) {
			expect(() => parseFrpRuntimeStateReport(value)).toThrow();
		}
	});

	it("严格解析批量 reconcile，且仅 Server→Client payload 可含 frpsInfo", () => {
		expect(
			parseFrpReconcilePayload({
				connectionGeneration: "conn-1",
				expectedRuntimeGeneration: 4,
				attempt: 1,
				timeoutSeconds: 30,
				frpsInfo: { serverAddr: "frps.example.com", serverPort: 7000, authToken: "secret" },
				mappings: [mapping],
				preservedMappings: [],
			}),
		).toMatchObject({ expectedRuntimeGeneration: 4, attempt: 1 });
	});

	it("严格解析 FRP 状态确认，拒绝未知字段与非法 action", () => {
		expect(parseFrpRuntimeStateAck({ connectionGeneration: "conn-1", accepted: true, action: "none" })).toEqual({
			connectionGeneration: "conn-1",
			accepted: true,
			action: "none",
		});
		for (const bad of [
			{ connectionGeneration: "conn-1", accepted: true, action: "none", extra: 1 },
			{ connectionGeneration: "", accepted: true, action: "none" },
			{ connectionGeneration: "conn-1", accepted: true, action: "weird" },
		]) {
			expect(() => parseFrpRuntimeStateAck(bad)).toThrow();
		}
	});
});
