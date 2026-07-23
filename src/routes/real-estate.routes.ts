import { Router } from "express";

import { RealEstateController } from "../controllers/real-estate.controller.js";
import { UserRole } from "../domain/roles.js";
import { asyncHandler } from "../middlewares/async-handler.js";
import { authorize, ensureAuthenticated } from "../middlewares/auth.js";

const realEstateRoutes = Router();
const realEstateController = new RealEstateController();

realEstateRoutes.use(ensureAuthenticated);

realEstateRoutes.get(
  "/",
  authorize(UserRole.ADMIN),
  asyncHandler(realEstateController.list),
);

export { realEstateRoutes };
