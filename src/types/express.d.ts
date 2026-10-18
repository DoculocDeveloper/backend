import type { UserRole } from "../domain/roles.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        realEstateId?: string | null;
      };
    }
  }
}
