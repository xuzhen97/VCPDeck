import { type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service.js";
export declare class AuthGuard implements CanActivate {
    private readonly reflector;
    private readonly prisma;
    constructor(reflector: Reflector, prisma: PrismaService);
    canActivate(context: ExecutionContext): Promise<boolean>;
    private resolveActor;
}
