import { describe, expect, it } from "vitest";
import { ACTOR } from "./test-helpers.js";
import { RemoteDevAttachmentService } from "./remote-dev-attachment.service.js";

describe("RemoteDevAttachmentService", () => {
	it("首个 attach 是 operator，第二个是 viewer", () => {
		const service = new RemoteDevAttachmentService();
		const a = service.attach("r1", ACTOR, "s1");
		const b = service.attach("r1", ACTOR, "s2");
		expect(a.mode).toBe("operator");
		expect(b.mode).toBe("viewer");
	});

	it("viewer 的 prompt 被拒绝", () => {
		const service = new RemoteDevAttachmentService();
		service.attach("r1", ACTOR, "s1");
		service.attach("r1", ACTOR, "s2");
		expect(() => service.assertOperator("r1", "s2")).toThrow(/operator/i);
		expect(() => service.assertOperator("r1", "s1")).not.toThrow();
	});

	it("operator 离开后 reconnect token 可恢复操作权", () => {
		const service = new RemoteDevAttachmentService();
		const first = service.attach("r1", ACTOR, "s1");
		service.detach("s1");
		const renewed = service.attach("r1", ACTOR, "s3", first.reconnectToken);
		expect(renewed.mode).toBe("operator");
	});

	it("takeover 把 operator 转给新 socket", () => {
		const service = new RemoteDevAttachmentService();
		service.attach("r1", ACTOR, "s1");
		service.attach("r1", ACTOR, "s2");
		service.takeover("r1", ACTOR, "s2");
		expect(service.modeOf("r1", "s2")).toBe("operator");
		expect(service.modeOf("r1", "s1")).toBe("viewer");
	});

	it("旧 socket 尚未断开时，同身份 reconnect token 也能接管 operator", () => {
		const service = new RemoteDevAttachmentService();
		const first = service.attach("r1", ACTOR, "s1");
		const renewed = service.attach("r1", ACTOR, "s2", first.reconnectToken);
		expect(renewed.mode).toBe("operator");
		expect(service.modeOf("r1", "s1")).toBe("viewer");
		expect(service.modeOf("r1", "s2")).toBe("operator");
	});

	it("其他身份不能使用 reconnect token 夺取 operator", () => {
		const service = new RemoteDevAttachmentService();
		const first = service.attach("r1", ACTOR, "s1");
		const other = { ...ACTOR, identityId: "id-2" };
		const denied = service.attach("r1", other, "s2", first.reconnectToken);
		expect(denied.mode).toBe("viewer");
		expect(service.modeOf("r1", "s1")).toBe("operator");
	});
});
