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

realEstateRoutes.get(
  "/profile",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(realEstateController.getProfile),
);

realEstateRoutes.patch(
  "/profile",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(realEstateController.updateProfile),
);

realEstateRoutes.get(
  "/:id",
  authorize(UserRole.ADMIN),
  asyncHandler(realEstateController.getById),
);

realEstateRoutes.get(
  "/:id/sellers",
  authorize(UserRole.ADMIN),
  asyncHandler(realEstateController.listSellers),
);

realEstateRoutes.post(
  "/:id/sellers",
  authorize(UserRole.ADMIN),
  asyncHandler(realEstateController.createSeller),
);

realEstateRoutes.delete(
  "/:id/sellers/:sellerId",
  authorize(UserRole.ADMIN),
  asyncHandler(realEstateController.deleteSeller),
);

export { realEstateRoutes };
