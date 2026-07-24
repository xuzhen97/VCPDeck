import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ActorContext } from "@vcpdeck/shared";

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActorContext => {
    const req = ctx.switchToHttp().getRequest();
    return req.actor;
  },
);
