import { describe, expect, it } from "vitest";
import {
	FRP_ERROR_CODES,
	FRP_MAPPING_STATUSES,
	FrpJobType,
	FrpProtocolError,
	JobType,
	parseFrpMappingCreateRequest,
	parseFrpOperationTimeout,
} from "./index.js";

describe("FRP shared contract", () => {
	it("公开收敛状态和稳定错误码", () => {
		expect(FRP_MAPPING_STATUSES).toEqual([
			"provisioning",
			"active",
			"inactive",
			"deleting",
			"error",
			"reconciling",
		]);
		expect(FRP_ERROR_CODES).toContain("FRPS_DASHBOARD_REQUIRED");
		expect(FRP_ERROR_CODES).toContain("FRP_PROXY_CONFIRM_TIMEOUT");
		expect(FRP_ERROR_CODES).toContain("FRP_ROLLBACK_FAILED");
		expect(FRP_ERROR_CODES).toContain("FRP_RECONCILE_BUSY");
		expect(FRP_ERROR_CODES).toContain("FRP_RECONCILE_FAILED");
		expect(FRP_ERROR_CODES).toContain("FRP_RUNTIME_GENERATION_STALE");
		expect(FRP_ERROR_CODES).toContain("FRP_RUNTIME_STATE_INVALID");
		expect(FRP_ERROR_CODES).toContain("FRP_RECONCILE_TIMEOUT");
	});

	it("两个 Job type 集合均包含 frp.reconcile", () => {
		expect(JobType.FRP_RECONCILE).toBe("frp.reconcile");
		expect(FrpJobType.FRP_RECONCILE).toBe("frp.reconcile");
	});

	it("解析 TCP 请求并补齐默认值，name 可省略", () => {
		expect(
			parseFrpMappingCreateRequest({
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 1919,
			}),
		).toEqual({
			clientId: "client-1",
			proxyType: "tcp",
			localIp: "127.0.0.1",
			localPort: 1919,
			timeoutSeconds: 30,
		});
	});

	it.each(["http", "https"] as const)(
		"解析 %s 请求并要求 customDomain",
		(proxyType) => {
			expect(
				parseFrpMappingCreateRequest({
					clientId: "client-1",
					name: "web-1",
					proxyType,
					localIp: "127.0.0.1",
					localPort: 8080,
					customDomain: "app.example.com",
					timeoutSeconds: 45,
				}),
			).toMatchObject({ proxyType, customDomain: "app.example.com" });
			expect(() =>
				parseFrpMappingCreateRequest({
					clientId: "client-1",
					proxyType,
					localPort: 8080,
				}),
			).toThrow(FrpProtocolError);
		},
	);

	it("拒绝类型冲突、注入字符、未知字段和非法端口", () => {
		const invalid = [
			{
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 1919,
				customDomain: "app.example.com",
			},
			{
				clientId: "client-1",
				proxyType: "http",
				localPort: 8080,
				remotePort: 20000,
				customDomain: "app.example.com",
			},
			{
				clientId: "client-1",
				name: "bad\"\nname",
				proxyType: "tcp",
				localPort: 1919,
			},
			{
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 0,
			},
			{
				clientId: "client-1",
				proxyType: "tcp",
				localPort: 1919,
				secret: "unexpected",
			},
		];
		for (const value of invalid) {
			expect(() => parseFrpMappingCreateRequest(value)).toThrow(
				FrpProtocolError,
			);
		}
	});

	it("限制确认超时为 1–300 秒", () => {
		expect(parseFrpOperationTimeout(undefined)).toBe(30);
		expect(parseFrpOperationTimeout("45")).toBe(45);
		for (const value of [0, 301, 1.5, "x"]) {
			expect(() => parseFrpOperationTimeout(value)).toThrow(FrpProtocolError);
		}
	});
});
