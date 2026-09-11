"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrpModule = void 0;
const common_1 = require("@nestjs/common");
const frp_service_js_1 = require("./frp.service.js");
const frp_controller_js_1 = require("./frp.controller.js");
const frp_reconciliation_service_js_1 = require("./frp-reconciliation.service.js");
const frp_instances_service_js_1 = require("./frp-instances.service.js");
const frp_instances_controller_js_1 = require("./frp-instances.controller.js");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
const events_module_js_1 = require("../events/events.module.js");
let FrpModule = class FrpModule {
};
exports.FrpModule = FrpModule;
exports.FrpModule = FrpModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_js_1.PrismaModule, (0, common_1.forwardRef)(() => events_module_js_1.EventsModule)],
        providers: [frp_service_js_1.FrpService, frp_instances_service_js_1.FrpsInstancesService, frp_reconciliation_service_js_1.FrpReconciliationService],
        controllers: [frp_controller_js_1.FrpController, frp_instances_controller_js_1.FrpsInstancesController],
        exports: [frp_service_js_1.FrpService, frp_reconciliation_service_js_1.FrpReconciliationService],
    })
], FrpModule);
