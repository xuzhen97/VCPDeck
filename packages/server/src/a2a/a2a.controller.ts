import {
	Body,
	Controller,
	Get,
	Inject,
	Post,
	Req,
} from "@nestjs/common";
import {
	A2aProtocolError,
	type A2aJsonRpcRequest,
	type A2aJsonRpcResponse,
	type ActorContext,
	parseA2aJsonRpcRequest,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { A2aService } from "./a2a.service.js";

function requestId(body: unknown): string | number | null {
	if (typeof body !== "object" || body === null) return null;
	const id = (body as { id?: unknown }).id;
	return typeof id === "string" || typeof id === "number" ? id : null;
}

/** A2A v1.0 JSON-RPC 子集；认证沿用全局 AuthGuard。 */
@Controller("api/a2a")
export class A2aController {
	constructor(@Inject(A2aService) private readonly service: A2aService) {}

	@Post()
	async rpc(
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<A2aJsonRpcResponse> {
		let request: A2aJsonRpcRequest;
		try {
			request = parseA2aJsonRpcRequest(body);
		} catch (error) {
			if (error instanceof A2aProtocolError) {
				return {
					jsonrpc: "2.0",
					id: requestId(body),
					error: { code: error.rpcCode, message: error.message },
				};
			}
			throw error;
		}
		return this.service.rpc(request, actor);
	}

	@Get("agent-card")
	async agentCard(
		@Req()
		req: { protocol: string; get(name: string): string | undefined },
	) {
		const configured = process.env.VCPDECK_PUBLIC_URL?.trim();
		const baseUrl =
			configured && configured.length > 0
				? configured
				: `${req.protocol}://${req.get("host") ?? "localhost"}`;
		return this.service.agentCard(baseUrl);
	}
}
