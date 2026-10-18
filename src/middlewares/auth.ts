import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UserRole } from "../domain/roles.js";
import { AppError } from "./error-handler.js";

type JwtPayload = {
  sub: string;
  role: UserRole;
  realEstateId?: string | null;
};

export function ensureAuthenticated(request: Request, _response: Response, next: NextFunction) {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(401, "Token ausente");
  }

  const [_, token] = authHeader.split(" ");

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    request.user = {
      id: payload.sub,
      role: payload.role,
      realEstateId: payload.realEstateId ?? null,
    };
    next();
  } catch {
    throw new AppError(401, "Token inválido");
  }
}

export function authorize(...roles: UserRole[]) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.user || !roles.includes(request.user.role)) {
      throw new AppError(403, "Acesso negado");
    }

    next();
  };
}
