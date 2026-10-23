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
        applications: {
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
                {
                  realEstateProfile: {
                    is: {
                      document: {
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
            realEstateSellerLinks: true,
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
        sellersCount: Math.max(_count.realEstateSellerLinks, _count.sellers),
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
        realEstateSellerLinks: {
          include: {
            seller: {
              select: {
                id: true,
                name: true,
                email: true,
                cpf: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        },
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
            realEstateSellerLinks: true,
            sellers: true,
          },
        },
      },
    });

    if (!realEstate) {
      throw new AppError(404, "Imobiliária não encontrada.");
    }

    const { _count, realEstateSellerLinks, sellers: legacySellers, ...rest } = realEstate;

    // Unificar lista de vendedores (tabela associativa + retrocompatibilidade)
    const sellersMap = new Map<string, any>();
    realEstateSellerLinks.forEach((link) => {
      sellersMap.set(link.seller.id, link.seller);
    });
    legacySellers.forEach((seller) => {
      if (!sellersMap.has(seller.id)) {
        sellersMap.set(seller.id, seller);
      }
    });

    const unifiedSellers = Array.from(sellersMap.values());

    return response.json({
      realEstate: {
        ...rest,
        sellers: unifiedSellers,
        applicationsCount: _count.applications,
        sellersCount: unifiedSellers.length,
      },
    });
  }

  async listSellers(request: Request, response: Response) {
    const id = String(request.params.id);

    const links = await prisma.realEstateSeller.findMany({
      where: { realEstateId: id },
      include: {
        seller: {
          select: {
            id: true,
            name: true,
            email: true,
            cpf: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const legacySellers = await prisma.user.findMany({
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

    const sellersMap = new Map<string, any>();
    links.forEach((l) => sellersMap.set(l.seller.id, l.seller));
    legacySellers.forEach((s) => {
      if (!sellersMap.has(s.id)) sellersMap.set(s.id, s);
    });

    return response.json({ sellers: Array.from(sellersMap.values()) });
  }

  async listAvailableSellers(request: Request, response: Response) {
    const realEstateId = String(request.params.id);
    const search =
      typeof request.query.search === "string"
        ? request.query.search.trim()
        : "";

    // Obter IDs dos vendedores já vinculados a esta imobiliária (tanto via link N:N quanto legado)
    const linkedIds = new Set<string>();

    try {
      const existingLinks = await prisma.realEstateSeller.findMany({
        where: { realEstateId },
        select: { sellerId: true },
      });
      existingLinks.forEach((l) => linkedIds.add(l.sellerId));
    } catch (e) {
      console.warn("[listAvailableSellers] Tabela RealEstateSeller em migracao:", e);
    }

    try {
      const legacyLinked = await prisma.user.findMany({
        where: { realEstateId, role: UserRole.SELLER },
        select: { id: true },
      });
      legacyLinked.forEach((l) => linkedIds.add(l.id));
    } catch (e) {
      console.warn("[listAvailableSellers] Erro ao buscar vendedores legados:", e);
    }

    const cleanCpfDigits = search.replace(/\D/g, "");

    const availableSellers = await prisma.user.findMany({
      where: {
        role: UserRole.SELLER,
        ...(linkedIds.size > 0
          ? {
              id: {
                notIn: Array.from(linkedIds),
              },
            }
          : {}),
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
                ...(cleanCpfDigits
                  ? [
                      {
                        cpf: {
                          contains: cleanCpfDigits,
                        },
                      },
                    ]
                  : []),
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        cpf: true,
        createdAt: true,
        realEstate: {
          select: {
            id: true,
            name: true,
            realEstateProfile: {
              select: {
                name: true,
              },
            },
          },
        },
        sellerRealEstateLinks: {
          select: {
            realEstate: {
              select: {
                id: true,
                name: true,
                realEstateProfile: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });

    return response.json({
      sellers: availableSellers.map((seller) => {
        const associatedNames = new Set<string>();

        if (seller.realEstate) {
          associatedNames.add(
            seller.realEstate.realEstateProfile?.name || seller.realEstate.name,
          );
        }

        if (seller.sellerRealEstateLinks) {
          seller.sellerRealEstateLinks.forEach((link) => {
            if (link.realEstate) {
              associatedNames.add(
                link.realEstate.realEstateProfile?.name || link.realEstate.name,
              );
            }
          });
        }

        return {
          id: seller.id,
          name: seller.name,
          email: seller.email,
          cpf: seller.cpf,
          createdAt: seller.createdAt,
          associatedRealEstates: Array.from(associatedNames),
        };
      }),
    });
  }

  async associateSeller(request: Request, response: Response) {
    const realEstateId = String(request.params.id);
    const bodySchema = z.object({
      sellerId: z.string().uuid("ID do vendedor inválido."),
    });

    const { sellerId } = bodySchema.parse(request.body);

    const realEstate = await prisma.user.findFirst({
      where: {
        id: realEstateId,
        role: UserRole.REAL_ESTATE,
      },
      select: {
        id: true,
        name: true,
        realEstateProfile: { select: { name: true } },
      },
    });

    if (!realEstate) {
      throw new AppError(404, "Imobiliária não encontrada.");
    }

    const seller = await prisma.user.findFirst({
      where: {
        id: sellerId,
        role: UserRole.SELLER,
      },
    });

    if (!seller) {
      throw new AppError(404, "Vendedor não encontrado.");
    }

    // Verificar se já está associado
    let isAlreadyLinked = seller.realEstateId === realEstate.id;
    try {
      const existingLink = await prisma.realEstateSeller.findUnique({
        where: {
          realEstateId_sellerId: {
            realEstateId: realEstate.id,
            sellerId: seller.id,
          },
        },
      });
      if (existingLink) {
        isAlreadyLinked = true;
      }
    } catch {
      // Ignora erro se tabela estiver em criacao
    }

    if (isAlreadyLinked) {
      throw new AppError(409, "Este vendedor já está associado a esta imobiliária.");
    }

    try {
      await prisma.realEstateSeller.create({
        data: {
          realEstateId: realEstate.id,
          sellerId: seller.id,
        },
      });
    } catch (e) {
      console.warn("[associateSeller] Falha ao criar RealEstateSeller:", e);
    }

    if (!seller.realEstateId) {
      await prisma.user.update({
        where: { id: seller.id },
        data: { realEstateId: realEstate.id },
      });
    }

    return response.status(200).json({
      message: "Vendedor associado com sucesso.",
      seller: {
        id: seller.id,
        name: seller.name,
        email: seller.email,
        cpf: seller.cpf,
        createdAt: seller.createdAt,
      },
    });
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

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          ...(cleanCpf ? [{ cpf: cleanCpf }] : []),
        ],
      },
    });

    if (existingUser) {
      if (existingUser.role !== UserRole.SELLER) {
        throw new AppError(
          409,
          "Já existe um usuário cadastrado com este e-mail ou CPF com outra função.",
        );
      }

      const alreadyLinked = await prisma.realEstateSeller.findUnique({
        where: {
          realEstateId_sellerId: {
            realEstateId: realEstate.id,
            sellerId: existingUser.id,
          },
        },
      });

      if (alreadyLinked || existingUser.realEstateId === realEstate.id) {
        throw new AppError(409, "Este vendedor já está associado a esta imobiliária.");
      }

      await prisma.realEstateSeller.create({
        data: {
          realEstateId: realEstate.id,
          sellerId: existingUser.id,
        },
      });

      return response.status(200).json({
        message: "Vendedor já existente na plataforma e agora associado a esta imobiliária com sucesso.",
        seller: {
          id: existingUser.id,
          name: existingUser.name,
          email: existingUser.email,
          cpf: existingUser.cpf,
          role: existingUser.role,
          createdAt: existingUser.createdAt,
        },
      });
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
        sellerRealEstateLinks: {
          create: {
            realEstateId: realEstate.id,
          },
        },
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

    const link = await prisma.realEstateSeller.findUnique({
      where: {
        realEstateId_sellerId: {
          realEstateId,
          sellerId,
        },
      },
    });

    const seller = await prisma.user.findFirst({
      where: {
        id: sellerId,
        role: UserRole.SELLER,
      },
      include: {
        sellerRealEstateLinks: true,
      },
    });

    if (!seller || (!link && seller.realEstateId !== realEstateId)) {
      throw new AppError(404, "Vínculo do vendedor com esta imobiliária não encontrado.");
    }

    if (link) {
      await prisma.realEstateSeller.delete({
        where: { id: link.id },
      });
    }

    if (seller.realEstateId === realEstateId) {
      const remainingLinks = seller.sellerRealEstateLinks.filter(
        (l) => l.realEstateId !== realEstateId,
      );
      const nextRealEstateId = remainingLinks[0]?.realEstateId ?? null;

      await prisma.user.update({
        where: { id: seller.id },
        data: { realEstateId: nextRealEstateId },
      });
    }

    return response.json({ message: "Vendedor desvinculado com sucesso desta imobiliária." });
  }
}


