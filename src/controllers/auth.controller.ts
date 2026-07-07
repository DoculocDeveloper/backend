// Libs
import { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// Schemas
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../schemas/auth.schemas.js";

// Utils
import { AppError } from "../middlewares/error-handler.js";
import { env } from "../config/env.js";
import { UserRole } from "../domain/roles.js";
import { mailService } from "../services/mail.service.js";
import { randomBytes } from "crypto";
import { buildPasswordResetEmail } from "../utils/build-password-reset-email.js";
import { hashToken } from "../utils/hash-token.js";

const realEstateProfileSelect = {
  id: true,
  name: true,
  cnpj: true,
  phone: true,
  responsibleName: true,

  zipCode: true,
  street: true,
  number: true,
  complement: true,
  neighborhood: true,
  city: true,
  state: true,

  createdAt: true,
  updatedAt: true,
} as const;

export class AuthController {
  async register(request: Request, response: Response) {
    const { name, email, role, password, ...rest } = registerSchema.parse(
      request.body,
    );
    const isRealEstate = role === UserRole.REAL_ESTATE;
    const realEstateProfile = rest.realEstateProfile;

    const emailAlreadyUsed = await prisma.user.findUnique({
      where: { email: email },
    });

    if (emailAlreadyUsed) {
      throw new AppError(409, "Email já cadastrado");
    }

    if (realEstateProfile?.cnpj) {
      const cnpjAlreadyUsed = await prisma.realEstateProfile.findUnique({
        where: { cnpj: realEstateProfile.cnpj },
      });

      if (cnpjAlreadyUsed) {
        throw new AppError(409, "CNPJ já cadastrado");
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name: isRealEstate ? realEstateProfile!.responsibleName : name!,
          email: email,
          passwordHash,
          role: role,
          ...(isRealEstate && realEstateProfile
            ? {
                realEstateProfile: {
                  create: {
                    name: realEstateProfile.name,
                    cnpj: realEstateProfile.cnpj,
                    phone: realEstateProfile.phone,
                    responsibleName: realEstateProfile.responsibleName,

                    zipCode: realEstateProfile.zipCode,
                    street: realEstateProfile.street,
                    number: realEstateProfile.number,
                    complement: realEstateProfile.complement,
                    neighborhood: realEstateProfile.neighborhood,
                    city: realEstateProfile.city,
                    state: realEstateProfile.state,
                  },
                },
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          realEstateProfile: {
            select: realEstateProfileSelect,
          },
        },
      });

      if (isRealEstate) {
        await tx.userCreditWallet.create({
          data: {
            userId: createdUser.id,
            availableCredits: 3,
            isVip: false,
          },
        });

        await tx.creditLedger.create({
          data: {
            userId: createdUser.id,
            type: "INITIAL_GRANT",
            amount: 3,
            balanceAfter: 3,
            reason: "Créditos gratuitos iniciais no cadastro",
          },
        });
      }

      return createdUser;
    });
    return response.status(201).json({ user });
  }

  async login(request: Request, response: Response) {
    const input = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        role: true,
        realEstateProfile: {
          select: realEstateProfileSelect,
        },
      },
    });

    if (!user) {
      throw new AppError(401, "Credenciais inválidas");
    }

    const passwordMatches = await bcrypt.compare(
      input.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new AppError(401, "Credenciais inválidas");
    }

    const expiresIn = user.role === "ADMIN" ? "7d" : "12h";

    const token = jwt.sign({ role: user.role }, env.JWT_SECRET, {
      subject: user.id,
      expiresIn: expiresIn,
    });

    return response.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        realEstateProfile: user.realEstateProfile,
      },
    });
  }

  async forgotPassword(request: Request, response: Response) {
    const { email } = forgotPasswordSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: email },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    const successResponse = {
      message:
        "Se um usuário com esse email existir, um link para resetar a senha será enviado.",
    };

    if (!user) {
      // Para evitar vazamento de informações, retornamos a mesma resposta mesmo que o usuário não exista
      return response.json(successResponse);
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(
      Date.now() + env.PASSWORD_RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000,
    );

    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });
    });

    const resetUrl = `${env.APP_URL.replace(/\/$/, "")}/reset-password?token=${token}`;

    await mailService.send({
      to: user.email,
      subject: "Redefinição de senha - Doculoc",
      html: buildPasswordResetEmail(user.name, resetUrl),
    });

    return response.json(successResponse);
  }

  async resetPassword(request: Request, response: Response) {
    const { token, password } = resetPasswordSchema.parse(request.body);
    const tokenHash = hashToken(token);

    const passwordResetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
          },
        },
      },
    });

    if (
      !passwordResetToken ||
      passwordResetToken.usedAt ||
      passwordResetToken.expiresAt < new Date()
    ) {
      throw new AppError(400, "Link de recuperação inválido ou expirado");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: passwordResetToken.user.id },
        data: { passwordHash },
      });

      await tx.passwordResetToken.update({
        where: { id: passwordResetToken.id },
        data: { usedAt: new Date() },
      });
    });

    return response.json({ message: "Senha redefinida com sucesso" });
  }
}