import { Router } from "express";
import { ReportController } from "../controllers/report.controller.js";
import { UserRole } from "../domain/roles.js";
import { asyncHandler } from "../middlewares/async-handler.js";
import { authorize, ensureAuthenticated } from "../middlewares/auth.js";

const reportRoutes = Router();
const reportController = new ReportController();

reportRoutes.use(ensureAuthenticated);

// Apenas administradores podem acessar relatórios
reportRoutes.get(
  "/summary",
  authorize(UserRole.ADMIN),
  asyncHandler(reportController.getSummary)
);

export { reportRoutes };
