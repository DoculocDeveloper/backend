// Express
import { Router } from "express";

// Controllers
import { SignatureController } from "../controllers/signature.controller.js";
import { ContractController } from "../controllers/contract.controller.js";

// Middlewares
import { ensureAuthenticated, authorize } from "../middlewares/auth.js";
import { asyncHandler } from "../middlewares/async-handler.js";

// Auth
import { UserRole } from "../domain/roles.js";

const contractRoutes = Router();

const contractController = new ContractController();
const signatureController = new SignatureController();

contractRoutes.use(ensureAuthenticated);

contractRoutes.post(
  "/applications/:applicationId/generate",
  authorize(UserRole.ADMIN),
  asyncHandler(contractController.generate),
);

contractRoutes.get(
  "/:id/download",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(contractController.download),
);

contractRoutes.post(
  "/:id/signature/send",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.send),
);

contractRoutes.get(
  "/:id/signature/status",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE),
  asyncHandler(signatureController.status),
);

export { contractRoutes };
