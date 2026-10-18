import { Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";

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
        rentalApplications: {
          some: {},
        },
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
            sellers: true,
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
        sellersCount: _count.sellers,
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

  async getById(request: Request, response: Response) {
    const id = String(request.params.id);

    const realEstate = await prisma.user.findFirst({
      where: {
        id,
        role: UserRole.REAL_ESTATE,
      },
      include: {
        realEstateProfile: true,
        wallet: true,
        sellers: {
          select: {
            id: true,
            name: true,
            email: true,
            cpf: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
        _count: {
          select: {
            applications: true,
            sellers: true,
          },
        },
      },
    });

    if (!realEstate) {
      throw new AppError(404, "Imobiliária não encontrada.");
    }

    const { _count, ...rest } = realEstate;

    return response.json({
      realEstate: {
        ...rest,
        applicationsCount: _count.applications,
        sellersCount: _count.sellers,
      },
    });
  }

  async listSellers(request: Request, response: Response) {
    const id = String(request.params.id);

    const sellers = await prisma.user.findMany({
      where: {
        realEstateId: id,
        role: UserRole.SELLER,
      },
      select: {
        id: true,
        name: true,
        email: true,
        cpf: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return response.json({ sellers });
  }

  async createSeller(request: Request, response: Response) {
    const realEstateId = String(request.params.id);

    const createSellerSchema = z.object({
      name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres."),
      cpf: z.string().min(11, "CPF inválido."),
      email: z.string().email("Informe um e-mail válido."),
      password: z.string().min(6, "A senha deve ter pelo menos 6 caracteres."),
    });

    const body = createSellerSchema.parse(request.body);

    const realEstate = await prisma.user.findFirst({
      where: {
        id: realEstateId,
        role: UserRole.REAL_ESTATE,
      },
    });

    if (!realEstate) {
      throw new AppError(404, "Imobiliária não encontrada.");
    }

    const normalizedEmail = body.email.trim().toLowerCase();
    const cleanCpf = body.cpf.replace(/\D/g, "");

    const emailAlreadyInUse = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (emailAlreadyInUse) {
      throw new AppError(409, "Este e-mail já está cadastrado.");
    }

    if (cleanCpf) {
      const cpfAlreadyInUse = await prisma.user.findFirst({
        where: {
          cpf: cleanCpf,
        },
      });

      if (cpfAlreadyInUse) {
        throw new AppError(409, "Este CPF já está cadastrado.");
      }
    }

    const passwordHash = await bcrypt.hash(body.password, 10);

    const seller = await prisma.user.create({
      data: {
        name: body.name.trim(),
        email: normalizedEmail,
        cpf: cleanCpf,
        passwordHash,
        role: UserRole.SELLER,
        realEstateId: realEstate.id,
      },
      select: {
        id: true,
        name: true,
        email: true,
        cpf: true,
        role: true,
        realEstateId: true,
        createdAt: true,
      },
    });

    return response.status(201).json({
      message: "Vendedor cadastrado com sucesso.",
      seller,
    });
  }

  async deleteSeller(request: Request, response: Response) {
    const realEstateId = String(request.params.id);
    const sellerId = String(request.params.sellerId);

    const seller = await prisma.user.findFirst({
      where: {
        id: sellerId,
        realEstateId,
        role: UserRole.SELLER,
      },
    });

    if (!seller) {
      throw new AppError(404, "Vendedor não encontrado para esta imobiliária.");
    }

    await prisma.user.delete({
      where: { id: seller.id },
    });

    return response.json({ message: "Vendedor removido com sucesso." });
  }
}


