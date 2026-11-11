import { Router } from "express";
import multer from "multer";
import { RentalApplicationController } from "../controllers/rental-application.controller.js";
import { RentalApplicationMessageController } from "../controllers/rental-application-message.controller.js";
import { ensureAuthenticated, authorize } from "../middlewares/auth.js";
import { UserRole } from "../domain/roles.js";
import { asyncHandler } from "../middlewares/async-handler.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

const rentalApplicationRoutes = Router();
const rentalApplicationController = new RentalApplicationController();
const messageController = new RentalApplicationMessageController();

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
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(rentalApplicationController.list),
);

rentalApplicationRoutes.get(
  "/consults/:id/status",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(rentalApplicationController.getConsultStatus),
);

rentalApplicationRoutes.get(
  "/unread-count",
  authorize(UserRole.ADMIN),
  asyncHandler(rentalApplicationController.unreadCount),
);

rentalApplicationRoutes.get(
  "/:id",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(rentalApplicationController.getById),
);

rentalApplicationRoutes.patch(
  "/:id/view",
  authorize(UserRole.ADMIN),
  asyncHandler(rentalApplicationController.markAsViewed),
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

rentalApplicationRoutes.post(
  "/:id/reopen",
  authorize(UserRole.ADMIN),
  asyncHandler(rentalApplicationController.reopen),
);

// Rotas de Mensagens e Anexos (Chat)
rentalApplicationRoutes.get(
  "/:id/messages",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(messageController.list),
);

rentalApplicationRoutes.post(
  "/:id/messages",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  upload.single("file"),
  asyncHandler(messageController.create),
);

rentalApplicationRoutes.get(
  "/:id/messages/:messageId/download",
  authorize(
    UserRole.ADMIN,
    UserRole.REAL_ESTATE,
    UserRole.ACCOUNT_EXECUTIVE,
    UserRole.SELLER,
  ),
  asyncHandler(messageController.download),
);

export { rentalApplicationRoutes };
