"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Actor = void 0;
const common_1 = require("@nestjs/common");
exports.Actor = (0, common_1.createParamDecorator)((_data, ctx) => {
    const req = ctx.switchToHttp().getRequest();
    return req.actor;
});
