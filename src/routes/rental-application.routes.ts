import { Router } from "express";
import { RentalApplicationController } from "../controllers/rental-application.controller.js";
import { ensureAuthenticated, authorize } from "../middlewares/auth.js";
import { UserRole } from "../domain/roles.js";
import { asyncHandler } from "../middlewares/async-handler.js";

const rentalApplicationRoutes = Router();
const rentalApplicationController = new RentalApplicationController();

rentalApplicationRoutes.use(ensureAuthenticated);

rentalApplicationRoutes.post(
  "/cpf",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.createByCpf),
);

rentalApplicationRoutes.post(
  "/cnpj",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.createByCnpj),
);

rentalApplicationRoutes.get(
  "/",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.list),
);

rentalApplicationRoutes.get(
  "/consults/:id/status",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.getConsultStatus),
);

rentalApplicationRoutes.get(
  "/:id",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.getById),
);

rentalApplicationRoutes.patch(
  "/:id/rental-values",
  authorize(UserRole.ADMIN),
  asyncHandler(rentalApplicationController.updateRentalValues),
);

rentalApplicationRoutes.patch(
  "/:id/contract-data",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.fillContractData),
);

rentalApplicationRoutes.post(
  "/:id/contest",
  authorize(UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.contest),
);

rentalApplicationRoutes.patch(
  "/:id/admin-decision",
  authorize(UserRole.ADMIN),
  asyncHandler(rentalApplicationController.adminDecide),
);

rentalApplicationRoutes.delete(
  "/:id",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(rentalApplicationController.delete),
);

export { rentalApplicationRoutes };
