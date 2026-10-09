import { Request, Response } from "express";
import { z } from "zod";

import { UserRole } from "../domain/roles.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../middlewares/error-handler.js";

export class RealEstateController {
  async list(request: Request, response: Response) {
    const search =
      typeof request.query.search === "string"
        ? request.query.search.trim()
        : "";

    const realEstates = await prisma.user.findMany({
      where: {
        role: UserRole.REAL_ESTATE,
        ...(search
          ? {
              OR: [
                {
                  name: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  email: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  realEstateProfile: {
                    is: {
                      name: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                  },
                },
                {
                  realEstateProfile: {
                    is: {
                      responsibleName: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                  },
                },
                {
                  realEstateProfile: {
                    is: {
                      cnpj: {
                        contains: search.replace(/\D/g, ""),
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        realEstateProfile: {
          select: {
            id: true,
            profileType: true,
            name: true,
            cnpj: true,
            documentType: true,
            document: true,
            phone: true,
            responsibleName: true,
            signatureEmail: true,
            zipCode: true,
            street: true,
            number: true,
            complement: true,
            neighborhood: true,
            city: true,
            state: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        wallet: {
          select: {
            id: true,
            availableCredits: true,
            isVip: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        _count: {
          select: {
            applications: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return response.json({
      realEstates: realEstates.map(({ _count, ...realEstate }) => ({
        ...realEstate,
        applicationsCount: _count.applications,
      })),
    });
  }

  async getProfile(request: Request, response: Response) {
    const userId = request.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        realEstateProfile: true,
      },
    });

    if (!user) {
      throw new AppError(404, "Usuário não encontrado");
    }

    return response.json({
      user,
      profile: user.realEstateProfile,
    });
  }

  async updateProfile(request: Request, response: Response) {
    const userId = request.user!.id;

    const bodySchema = z.object({
      signatureEmail: z
        .string()
        .email("Informe um e-mail válido.")
        .nullable()
        .optional()
        .or(z.literal("")),
    });

    const parsed = bodySchema.parse(request.body);
    const normalizedEmail = parsed.signatureEmail?.trim() || null;

    const profile = await prisma.realEstateProfile.update({
      where: { userId },
      data: {
        signatureEmail: normalizedEmail,
      },
    });

    return response.json({
      message: "Configurações atualizadas com sucesso.",
      profile,
    });
  }
}

