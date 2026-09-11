import { type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "../../generated/client/index.js";
export declare class PrismaService extends PrismaClient implements OnModuleInit {
    constructor();
    onModuleInit(): Promise<void>;
}
