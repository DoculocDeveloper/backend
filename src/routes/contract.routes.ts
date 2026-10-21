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
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE, UserRole.SELLER),
  asyncHandler(contractController.download.bind(contractController)),
);

contractRoutes.get(
  "/:id/signed-download",
  authorize(UserRole.ADMIN, UserRole.REAL_ESTATE, UserRole.SELLER),
  asyncHandler(contractController.downloadSigned.bind(contractController)),
);

contractRoutes.post(
  "/:id/signature/send",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.send),
);

contractRoutes.get(
  "/:id/signature/status",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(signatureController.status),
);

contractRoutes.post(
  "/:id/signature/resend-notification",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.resendNotification),
);

contractRoutes.post(
  "/:id/signature/cancel",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.cancel),
);

contractRoutes.post(
  "/:id/signature/restart",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.restart),
);

contractRoutes.post(
  "/:id/signature/reopen-contract-data",
  authorize(UserRole.ADMIN),
  asyncHandler(signatureController.reopenContractData),
);

export { contractRoutes };
