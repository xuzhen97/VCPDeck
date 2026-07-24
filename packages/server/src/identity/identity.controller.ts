import { Controller, Get, Post, Param, Body, ForbiddenException } from "@nestjs/common";
import type { IdentityService } from "./identity.service.js";
import { Actor } from "../auth/actor.decorator.js";
import type { ActorContext, CreateIdentityRequest, IdentityInfo } from "@vcpdeck/shared";

@Controller("api/identities")
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  private checkAdmin(actor: ActorContext) {
    if (!actor.isAdmin) {
      throw new ForbiddenException({ statusCode: 403, code: "FORBIDDEN", message: "Admin only" });
    }
  }

  @Get()
  async list(@Actor() actor: ActorContext): Promise<IdentityInfo[]> {
    this.checkAdmin(actor);
    return this.identityService.list();
  }

  @Post()
  async create(@Actor() actor: ActorContext, @Body() body: CreateIdentityRequest): Promise<IdentityInfo> {
    this.checkAdmin(actor);
    return this.identityService.create(body.username, body.password, body.displayName);
  }

  @Post(":id/disable")
  async disable(@Actor() actor: ActorContext, @Param("id") id: string) {
    this.checkAdmin(actor);
    await this.identityService.disable(id);
    return { ok: true };
  }

  @Post(":id/enable")
  async enable(@Actor() actor: ActorContext, @Param("id") id: string) {
    this.checkAdmin(actor);
    await this.identityService.enable(id);
    return { ok: true };
  }
}
