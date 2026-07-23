import { Router } from "express";

import { rentalApplicationRoutes } from "./rental-application.routes.js";
import { realEstateRoutes } from "./real-estate.routes.js";
import { contractRoutes } from "./contract.routes.js";
import { webhookRoutes } from "./webhook.routes.js";
import { creditRoutes } from "./credit.routes.js";
import { systemRoutes } from "./system.routes.js";
import { authRoutes } from "./auth.routes.js";

const routes = Router();

routes.use("/auth", authRoutes);
routes.use("/system", systemRoutes);
routes.use("/credits", creditRoutes);
routes.use("/real-estates", realEstateRoutes);
routes.use("/rental-applications", rentalApplicationRoutes);
routes.use("/contracts", contractRoutes);
routes.use("/webhooks", webhookRoutes);

export { routes };