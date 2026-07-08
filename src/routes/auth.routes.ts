// Libs
import { Router } from "express";

// Middlewares
import { asyncHandler } from "../middlewares/async-handler.js";
import { ensureAuthenticated } from "../middlewares/auth.js";

// Controllers
import { AuthController } from "../controllers/auth.controller.js";

const authRoutes = Router();
const authController = new AuthController();

authRoutes.post("/register", asyncHandler(authController.register));

authRoutes.post("/login", asyncHandler(authController.login));

authRoutes.post("/forgot-password", asyncHandler(authController.forgotPassword));

authRoutes.post("/reset-password", asyncHandler(authController.resetPassword));

authRoutes.get("/me", ensureAuthenticated, asyncHandler(authController.me));

export { authRoutes };