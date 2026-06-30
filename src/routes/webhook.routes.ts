import { Router } from "express";
import { ClicksignWebhookController } from "../controllers/clicksign-webhook.controller.js";
import { asyncHandler } from "../middlewares/async-handler.js";

const webhookRoutes = Router();
const clicksignWebhookController = new ClicksignWebhookController();

webhookRoutes.post(
  "/clicksign",
  asyncHandler(clicksignWebhookController.handle),
);

export { webhookRoutes };
