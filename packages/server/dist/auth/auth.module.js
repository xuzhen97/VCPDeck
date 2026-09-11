"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const auth_service_js_1 = require("./auth.service.js");
const auth_controller_js_1 = require("./auth.controller.js");
const auth_guard_js_1 = require("./auth.guard.js");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_js_1.PrismaModule],
        providers: [
            auth_service_js_1.AuthService,
            auth_guard_js_1.AuthGuard,
            { provide: core_1.APP_GUARD, useClass: auth_guard_js_1.AuthGuard },
        ],
        controllers: [auth_controller_js_1.AuthController],
        exports: [auth_service_js_1.AuthService, auth_guard_js_1.AuthGuard],
    })
], AuthModule);
