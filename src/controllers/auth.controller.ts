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
  createAccountExecutiveSchema,
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
  profileType: true,
  name: true,
  cnpj: true,
  documentType: true,
  document: true,
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

function onlyDigits(value?: string | null) {
  return String(value ?? "").replace(/\D/g, "");
}

function getProfileDocumentType(profileType?: string) {
  return profileType === "AUTONOMOUS_BROKER" ? "CPF" : "CNPJ";
}

function getProfileTypeLabel(profileType?: string) {
  return profileType === "AUTONOMOUS_BROKER"
    ? "Corretor autônomo"
    : "Imobiliária";
}

export class AuthController {
  async register(request: Request, response: Response) {
    const { name, email, role, password, ...rest } = registerSchema.parse(
      request.body,
    );
    const isRealEstate = role === UserRole.REAL_ESTATE;
    const realEstateProfile = rest.realEstateProfile;

    const profileType = realEstateProfile?.profileType ?? "COMPANY";
    const documentType = getProfileDocumentType(profileType);
    const profileDocument = onlyDigits(
      realEstateProfile?.document ?? realEstateProfile?.cnpj,
    );

    const emailAlreadyUsed = await prisma.user.findUnique({
      where: { email: email },
    });

    if (emailAlreadyUsed) {
      throw new AppError(
        409,
        "Este e-mail já está cadastrado.",
        "EMAIL_ALREADY_USED",
      );
    }

    if (isRealEstate) {
      const documentAlreadyUsed = await prisma.realEstateProfile.findFirst({
        where: {
          OR: [
            {
              document: profileDocument,
            },
            ...(documentType === "CNPJ"
              ? [
                  {
                    cnpj: profileDocument,
                  },
                ]
              : []),
          ],
        },
      });

      if (documentAlreadyUsed) {
        throw new AppError(
          409,
          documentType === "CPF"
            ? "Este CPF já está cadastrado."
            : "Este CNPJ já está cadastrado.",
          "DOCUMENT_ALREADY_USED",
        );
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
                    profileType,
                    name: realEstateProfile.name,

                    documentType,
                    document: profileDocument,

                    // Mantém compatibilidade com telas antigas que ainda leem cnpj.
                    cnpj: documentType === "CNPJ" ? profileDocument : null,

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

    if (
      isRealEstate &&
      user.realEstateProfile &&
      env.NEW_REAL_ESTATE_NOTIFICATION_TO &&
      env.RESEND_API_KEY &&
      env.MAIL_FROM
    ) {
      const profile = user.realEstateProfile;

      mailService
        .send({
          to: env.NEW_REAL_ESTATE_NOTIFICATION_TO,
          subject: `${getProfileTypeLabel(profile.profileType)} cadastrado - Doculoc`,
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.5;">
              <h2>${getProfileTypeLabel(profile.profileType)} cadastrado</h2>

              <p>Um novo lead acabou de se cadastrar na Doculoc.</p>

              <ul>
                <li><strong>Tipo:</strong> ${getProfileTypeLabel(profile.profileType)}</li>
                <li><strong>Nome:</strong> ${profile.name}</li>
                <li><strong>Responsável:</strong> ${profile.responsibleName}</li>
                <li><strong>E-mail:</strong> ${user.email}</li>
                <li><strong>Telefone:</strong> ${profile.phone ?? "Não informado"}</li>
                <li><strong>${profile.documentType === "CPF" ? "CPF" : "CNPJ"}:</strong> ${profile.document ?? profile.cnpj ?? "Não informado"}</li>
              </ul>

              <p>
                Acesse o painel para acompanhar:
                <br />
                <a href="${env.APP_URL.replace(/\/$/, "")}/admin/imobiliarias">
                  Abrir tela de imobiliárias
                </a>
              </p>
            </div>
          `,
        })
        .catch((error) => {
          console.error("[NEW_REAL_ESTATE_NOTIFICATION_ERROR]", error);
        });
    }

    return response.status(201).json({ user });
  }

  async createAccountExecutive(request: Request, response: Response) {
    const input = createAccountExecutiveSchema.parse(request.body);

    const emailAlreadyUsed = await prisma.user.findUnique({
      where: {
        email: input.email,
      },
    });

    if (emailAlreadyUsed) {
      throw new AppError(
        409,
        "Este e-mail já está cadastrado.",
        "EMAIL_ALREADY_USED",
      );
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: UserRole.ACCOUNT_EXECUTIVE,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
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

  async me(request: Request, response: Response) {
    const user = await prisma.user.findUnique({
      where: {
        id: request.user!.id,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        realEstateProfile: {
          select: realEstateProfileSelect,
        },
      },
    });

    if (!user) {
      throw new AppError(401, "Usuário não encontrado");
    }

    return response.json({ user });
  }
}
