import { Request, Response } from "express";

import { UserRole } from "../domain/roles.js";
import { prisma } from "../lib/prisma.js";

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
}
