import { Controller, Post, Get, Put, Delete, Body, Res, Param } from "@nestjs/common";
import type { Response } from "express";
import type { AuthService } from "./auth.service.js";
import { Public } from "./public.decorator.js";
import { Actor } from "./actor.decorator.js";
import type {
  ActorContext,
  LoginRequest,
  LoginResponse,
  IdentityInfo,
  UpdateMeRequest,
  CreateTokenRequest,
  TokenInfo,
  CreateTokenResponse,
} from "@vcpdeck/shared";

const COOKIE_SECURE = process.env.VCPDECK_COOKIE_SECURE !== "false";
const SESSION_TTL = parseInt(process.env.VCPDECK_SESSION_TTL_SECONDS || "604800", 10) * 1000;

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  async login(@Body() body: LoginRequest, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    try {
      const { sessionToken, identity } = await this.authService.login(body.username, body.password);
      res.cookie("vcpdeck_session", sessionToken, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_TTL,
      });
      return { identity };
    } catch (e: any) {
      const code = e.message;
      if (code === "IDENTITY_DISABLED") {
        throw Object.assign(new Error("Identity disabled"), { statusCode: 401, code });
      }
      throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
    }
  }

  @Post("logout")
  async logout(@Actor() actor: ActorContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(actor);
    res.clearCookie("vcpdeck_session", { path: "/" });
    return { ok: true };
  }

  @Get("me")
  async getMe(@Actor() actor: ActorContext): Promise<IdentityInfo> {
    return this.authService.getMe(actor);
  }

  @Put("me")
  async updateMe(@Actor() actor: ActorContext, @Body() body: UpdateMeRequest) {
    try {
      await this.authService.updateMe(actor, body);
      return { ok: true };
    } catch (e: any) {
      if (e.message === "USERNAME_TAKEN") {
        throw Object.assign(new Error("Username already taken"), { statusCode: 409, code: "USERNAME_TAKEN" });
      }
      throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
    }
  }

  @Post("tokens")
  async createToken(@Actor() actor: ActorContext, @Body() body: CreateTokenRequest): Promise<CreateTokenResponse> {
    return this.authService.createToken(actor, body.label);
  }

  @Get("tokens")
  async listTokens(@Actor() actor: ActorContext): Promise<TokenInfo[]> {
    return this.authService.listTokens(actor);
  }

  @Delete("tokens/:id")
  async revokeToken(@Actor() actor: ActorContext, @Param("id") id: string) {
    await this.authService.revokeToken(actor, id);
    return { ok: true };
  }
}
