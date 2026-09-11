import type { Response } from "express";
import { AuthService } from "./auth.service.js";
import type { ActorContext, LoginRequest, LoginResponse, IdentityInfo, UpdateMeRequest, CreateTokenRequest, TokenInfo, CreateTokenResponse } from "@vcpdeck/shared";
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    login(body: LoginRequest, res: Response): Promise<LoginResponse>;
    logout(actor: ActorContext, res: Response): Promise<{
        ok: boolean;
    }>;
    getMe(actor: ActorContext): Promise<IdentityInfo>;
    updateMe(actor: ActorContext, body: UpdateMeRequest): Promise<{
        ok: boolean;
    }>;
    createToken(actor: ActorContext, body: CreateTokenRequest): Promise<CreateTokenResponse>;
    listTokens(actor: ActorContext): Promise<TokenInfo[]>;
    revokeToken(actor: ActorContext, id: string): Promise<{
        ok: boolean;
    }>;
}
