// Libs
import { Router } from "express";

// Middlewares
import { asyncHandler } from "../middlewares/async-handler.js";
import { ensureAuthenticated, authorize } from "../middlewares/auth.js";
import { UserRole } from "../domain/roles.js";

// Controllers
import { AuthController } from "../controllers/auth.controller.js";

const authRoutes = Router();
const authController = new AuthController();

authRoutes.post("/register", asyncHandler(authController.register));

authRoutes.post("/account-executives", ensureAuthenticated, authorize(UserRole.ADMIN), asyncHandler(authController.createAccountExecutive));

authRoutes.post("/login", asyncHandler(authController.login));

authRoutes.post("/forgot-password", asyncHandler(authController.forgotPassword));

authRoutes.post("/reset-password", asyncHandler(authController.resetPassword));

authRoutes.get("/me", ensureAuthenticated, asyncHandler(authController.me));

export { authRoutes };