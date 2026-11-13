// Libs
import { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

// Errors
import { AppError } from "../middlewares/error-handler.js";

// Services
import { RentalApplicationService } from "../services/rental-application.service.js";

// Schemas
import {
  adminDecisionSchema,
  contestRentalApplicationSchema,
  createRentalApplicationByCnpjSchema,
  createRentalApplicationByCpfSchema,
  declineRentalApplicationSchema,
  updateRentalValuesSchema,
  fillContractDataSchema,
  listRentalApplicationsSchema,
  rentalApplicationParamsSchema,
} from "../schemas/rental-application.schemas.js";

// Types
import { UserRole } from "../domain/roles.js";

// Utils
import { extractApplicantName } from "../utils/extract-applicant-name.js";

const rentalApplicationService = new RentalApplicationService();

function parseJsonSafe(value?: string | null) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class RentalApplicationController {
  async createByCpf(request: Request, response: Response) {
    const input = createRentalApplicationByCpfSchema.parse(request.body);

    const result = await rentalApplicationService.createByCpf({
      requesterId: request.user!.id,
      ...input,
    });

    if ("pending" in result && result.pending) {
      return response.status(202).json(result);
    }

    if ("application" in result && result.application) {
      const sanitized = {
        ...result.application,
        oragoData: undefined,
        oragoRawResponse: undefined,
        tenants: (result.application as any).tenants?.map((t: any) => ({
          ...t,
          oragoData: undefined,
        })),
      };
      return response.status(201).json({ ...result, application: sanitized });
    }

    return response.status(201).json(result);
  }

  async createByCnpj(request: Request, response: Response) {
    const input = createRentalApplicationByCnpjSchema.parse(request.body);

    const result = await rentalApplicationService.createByCnpj({
      requesterId: request.user!.id,
      ...input,
    });

    if ("pending" in result && result.pending) {
      return response.status(202).json(result);
    }

    if ("application" in result && result.application) {
      const sanitized = {
        ...result.application,
        oragoData: undefined,
        oragoRawResponse: undefined,
        tenants: (result.application as any).tenants?.map((t: any) => ({
          ...t,
          oragoData: undefined,
        })),
      };
      return response.status(201).json({ ...result, application: sanitized });
    }

    return response.status(201).json(result);
  }

  async list(request: Request, response: Response) {
    const query = listRentalApplicationsSchema.parse(request.query);

    const canSeeAllApplications =
      request.user!.role === UserRole.ADMIN ||
      request.user!.role === UserRole.ACCOUNT_EXECUTIVE;

    const search = query.search?.trim();
    const searchDigits = search?.replace(/\D/g, "");

    const searchFilter = search
      ? {
          OR: [
            ...(searchDigits
              ? [
                  {
                    document: {
                      contains: searchDigits,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    tenantDocument: {
                      contains: searchDigits,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    tenants: {
                      some: {
                        document: {
                          contains: searchDigits,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                  },
                ]
              : []),

            {
              tenantName: {
                contains: search,
                mode: "insensitive" as const,
              },
            },
            {
              tenantEmail: {
                contains: search,
                mode: "insensitive" as const,
              },
            },
            {
              tenants: {
                some: {
                  name: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              },
            },
            {
              tenants: {
                some: {
                  email: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              },
            },
            {
              requester: {
                is: {
                  name: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              },
            },
            {
              requester: {
                is: {
                  email: {
                    contains: search,
                    mode: "insensitive" as const,
                  },
                },
              },
            },
            {
              requester: {
                is: {
                  realEstateProfile: {
                    is: {
                      name: {
                        contains: search,
                        mode: "insensitive" as const,
                      },
                    },
                  },
                },
              },
            },
          ],
        }
      : {};

    let requesterFilter: any;
    if (canSeeAllApplications) {
      requesterFilter = query.requesterId ? { requesterId: query.requesterId } : {};
    } else if (request.user!.role === UserRole.SELLER) {
      const associations = await prisma.realEstateSeller.findMany({
        where: { sellerId: request.user!.id },
        select: { realEstateId: true },
      });
      const allowedIds = associations.map((a) => a.realEstateId);
      if (
        request.user!.realEstateId &&
        !allowedIds.includes(request.user!.realEstateId)
      ) {
        allowedIds.push(request.user!.realEstateId);
      }
      requesterFilter = {
        requesterId: { in: allowedIds.length > 0 ? allowedIds : ["none"] },
      };
    } else {
      requesterFilter = { requesterId: request.user!.id };
    }

    let baseWhere: any;

    if (query.contractView === "PENDING") {
      baseWhere = {
        OR: [
          { status: "WAITING_ADMIN_CONTRACT" as const },
          {
            status: "CONTRACT_GENERATED" as const,
            contract: {
              is: {
                signatureStatus: { not: "SIGNED" as const },
              },
            },
          },
        ],
        ...searchFilter,
      };
    } else if (query.contractView === "SIGNED") {
      baseWhere = {
        status: "CONTRACT_GENERATED" as const,
        contract: {
          is: {
            signatureStatus: "SIGNED" as const,
          },
        },
        ...searchFilter,
      };
    } else {
      const contractCondition = query.signatureStatus
        ? { is: { signatureStatus: query.signatureStatus } }
        : undefined;

      baseWhere = {
        ...(query.status ? { status: query.status } : {}),
        ...(contractCondition ? { contract: contractCondition } : {}),
        ...searchFilter,
      };
    }

    const where = {
      ...requesterFilter,
      ...baseWhere,
    };

    const [applications, total] = await Promise.all([
      prisma.rentalApplication.findMany({
        where,
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: canSeeAllApplications
          ? [
              { hasUnreadStaffMessages: "desc" },
              { createdAt: "desc" },
            ]
          : [
              { hasUnreadClientMessages: "desc" },
              { createdAt: "desc" },
            ],
        include: {
          requester: {
            select: {
              id: true,
              name: true,
              email: true,
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
                  zipCode: true,
                  street: true,
                  number: true,
                  complement: true,
                  neighborhood: true,
                  city: true,
                  state: true,
                },
              },
            },
          },
          contract: {
            include: {
              signers: true,
            },
          },
          contests: true,
          tenants: {
            orderBy: {
              order: "asc",
            },
          },
          messages: {
            take: 1,
            orderBy: {
              createdAt: "desc",
            },
            select: {
              id: true,
              content: true,
              attachmentFileName: true,
              isStaff: true,
              createdAt: true,
              sender: {
                select: {
                  name: true,
                  role: true,
                },
              },
            },
          },
          _count: {
            select: {
              messages: {
                where: {
                  readAt: null,
                  isStaff: !canSeeAllApplications,
                },
              },
            },
          },
        },
      }),
      prisma.rentalApplication.count({ where }),
    ]);

    const isAdmin = request.user!.role === UserRole.ADMIN;
    const isSeller = request.user!.role === UserRole.SELLER;

    return response.json({
      applications: applications.map((application) => {
        const unreadCount = isSeller ? 0 : ((application as any)._count?.messages ?? 0);
        const lastMessage = !isSeller && (application as any).messages?.[0] ? (application as any).messages[0] : null;
        const hasChatHistory = !isSeller && Boolean(lastMessage);

        return {
          ...application,
          oragoData: isAdmin ? application.oragoData : undefined,
          oragoRawResponse: undefined,
          decisionReasons: JSON.parse(application.decisionReasons),
          decisionMetadata: application.decisionMetadata
            ? JSON.parse(application.decisionMetadata)
            : null,
          unreadMessagesCount: unreadCount,
          hasUnreadMessages: unreadCount > 0,
          hasChatHistory,
          lastChatMessage: lastMessage
            ? {
                content: lastMessage.content,
                attachmentFileName: lastMessage.attachmentFileName,
                isStaff: lastMessage.isStaff,
                senderName: lastMessage.sender?.name,
                createdAt: lastMessage.createdAt,
              }
            : null,
        };
      }),
      meta: {
        page: query.page,
        perPage: query.perPage,
        total,
        lastPage: Math.ceil(total / query.perPage),
      },
    });
  }

  async getConsultStatus(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);

    const result = await rentalApplicationService.getConsultStatus({
      consultLockId: params.id,
      requesterId: request.user!.id,
      role: request.user!.role,
    });

    if (result.status === "PROCESSING") {
      return response.status(202).json(result);
    }

    const isAdmin = request.user!.role === UserRole.ADMIN;
    if (!isAdmin && "application" in result && (result as any).application) {
      const sanitized = {
        ...(result as any).application,
        oragoData: undefined,
        oragoRawResponse: undefined,
        tenants: (result as any).application.tenants?.map((t: any) => ({
          ...t,
          oragoData: undefined,
        })),
      };
      return response.json({ ...result, application: sanitized });
    }

    return response.json(result);
  }

  async getById(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);

    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.id,
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true,
            email: true,
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
                zipCode: true,
                street: true,
                number: true,
                complement: true,
                neighborhood: true,
                city: true,
                state: true,
              },
            },
          },
        },
        contests: true,
        contract: {
          include: {
            signers: {
              orderBy: {
                createdAt: "asc",
              },
            },
          },
        },
        tenants: {
          orderBy: {
            order: "asc",
          },
        },
        _count: {
          select: {
            messages: {
              where: {
                readAt: null,
                isStaff: !(
                  request.user!.role === UserRole.ADMIN ||
                  request.user!.role === UserRole.ACCOUNT_EXECUTIVE
                ),
              },
            },
          },
        },
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    let sellerAllowedRealEstateIds: string[] = [];
    if (request.user!.role === UserRole.SELLER) {
      const associations = await prisma.realEstateSeller.findMany({
        where: { sellerId: request.user!.id },
        select: { realEstateId: true },
      });
      sellerAllowedRealEstateIds = associations.map((a) => a.realEstateId);
      if (
        request.user!.realEstateId &&
        !sellerAllowedRealEstateIds.includes(request.user!.realEstateId)
      ) {
        sellerAllowedRealEstateIds.push(request.user!.realEstateId);
      }
    }

    const canSeeApplication =
      request.user!.role === UserRole.ADMIN ||
      request.user!.role === UserRole.ACCOUNT_EXECUTIVE ||
      application.requesterId === request.user!.id ||
      (request.user!.role === UserRole.SELLER &&
        sellerAllowedRealEstateIds.includes(application.requesterId));

    if (!canSeeApplication) {
      throw new AppError(403, "Acesso negado");
    }

    if (request.user!.role === UserRole.ADMIN && !application.adminViewedAt) {
      const now = new Date();
      await prisma.rentalApplication.update({
        where: { id: application.id },
        data: { adminViewedAt: now },
      });
      application.adminViewedAt = now;
    }

    // Auto-sincronização de status com o histórico do chat:
    // Se a última mensagem foi enviada pela Doculoc (staff) e a imobiliária ainda não respondeu,
    // sincroniza o status para WAITING_REAL_ESTATE_RETURN garantindo que consultas pendentes de resposta reflitam o estado real.
    const lastChatMessage = await prisma.rentalApplicationMessage.findFirst({
      where: { applicationId: application.id },
      orderBy: { createdAt: "desc" },
      select: { isStaff: true },
    });

    if (lastChatMessage) {
      const nonTransitionStatuses = [
        "CONTRACT_DECLINED",
        "CANCELLED",
        "CONTRACT_GENERATED",
      ];

      if (
        lastChatMessage.isStaff &&
        application.status !== "WAITING_REAL_ESTATE_RETURN" &&
        !nonTransitionStatuses.includes(application.status)
      ) {
        await prisma.rentalApplication.update({
          where: { id: application.id },
          data: {
            status: "WAITING_REAL_ESTATE_RETURN",
            previousStatus: application.status,
            hasUnreadClientMessages: true,
          },
        });
        application.previousStatus = application.status;
        application.status = "WAITING_REAL_ESTATE_RETURN";
      } else if (
        !lastChatMessage.isStaff &&
        application.status === "WAITING_REAL_ESTATE_RETURN"
      ) {
        const restoredStatus =
          application.previousStatus || "WAITING_CONTRACT_DATA";
        await prisma.rentalApplication.update({
          where: { id: application.id },
          data: {
            status: restoredStatus as any,
            previousStatus: null,
            hasUnreadStaffMessages: true,
          },
        });
        application.status = restoredStatus as any;
        application.previousStatus = null;
      }
    }

    const parsedOragoData = parseJsonSafe(application.oragoData);

    const tenantName =
      application.tenantName ??
      extractApplicantName(application.documentType, parsedOragoData);

    const tenantDocument = application.tenantDocument ?? application.document;

    const tenants =
      application.tenants.length > 0
        ? application.tenants
        : tenantName
          ? [
              {
                id: "legacy-main-tenant",
                applicationId: application.id,
                order: 1,
                name: tenantName,
                document: tenantDocument,
                email: application.tenantEmail ?? "",
                phone: application.tenantPhone ?? "",
                createdAt: application.createdAt,
                updatedAt: application.updatedAt,
              },
            ]
          : [];

    const isAdmin = request.user!.role === UserRole.ADMIN;

    const sanitizedTenants = tenants.map((tenant) => ({
      ...tenant,
      oragoData: isAdmin ? parseJsonSafe((tenant as any).oragoData) : undefined,
    }));

    const isSeller = request.user!.role === UserRole.SELLER;
    const unreadCount = isSeller ? 0 : ((application as any)._count?.messages ?? 0);

    return response.json({
      application: {
        ...application,
        tenantName,
        tenantDocument,
        tenants: sanitizedTenants,
        decisionReasons: JSON.parse(application.decisionReasons),
        decisionMetadata: application.decisionMetadata
          ? JSON.parse(application.decisionMetadata)
          : null,
        unreadMessagesCount: unreadCount,
        hasUnreadMessages: unreadCount > 0,
        oragoRawResponse: undefined,
        oragoData: isAdmin ? parsedOragoData : undefined,
      },
    });
  }

  async updateRentalValues(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const body = updateRentalValuesSchema.parse(request.body);

    const application = await rentalApplicationService.updateRentalValues({
      applicationId: params.id,
      adminId: request.user!.id,
      data: body,
    });

    return response.json({ application });
  }

  async fillContractData(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const body = fillContractDataSchema.parse(request.body);

    const application = await rentalApplicationService.fillContractData({
      applicationId: params.id,
      requesterId: request.user!.id,
      data: body,
    });

    const isAdmin = request.user!.role === UserRole.ADMIN;

    return response.json({
      application: {
        ...application,
        oragoData: isAdmin ? application.oragoData : undefined,
        oragoRawResponse: undefined,
      },
    });
  }

  async contest(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const body = contestRentalApplicationSchema.parse(request.body);

    const contest = await rentalApplicationService.contest({
      applicationId: params.id,
      requesterId: request.user!.id,
      reason: body.reason,
    });

    return response.status(201).json({ contest });
  }

  async adminDecide(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const body = adminDecisionSchema.parse(request.body);

    const application = await rentalApplicationService.adminDecide({
      applicationId: params.id,
      adminId: request.user!.id,
      decision: body.decision,
      reason: body.reason,
    });

    return response.json({ application });
  }

  async decline(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const body = declineRentalApplicationSchema.parse(request.body);

    const application = await rentalApplicationService.declineApplication({
      applicationId: params.id,
      userId: request.user!.id,
      userRole: request.user!.role,
      reason: body.reason,
    });

    return response.json({ application });
  }

  async delete(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);

    await rentalApplicationService.deleteApplication({
      applicationId: params.id,
      requesterId: request.user!.id,
      role: request.user!.role,
    });

    return response.status(204).send();
  }

  async reopen(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);

    const application = await rentalApplicationService.reopenForEditing({
      applicationId: params.id,
    });

    return response.json({ application });
  }

  async unreadCount(request: Request, response: Response) {
    const result = await rentalApplicationService.getUnreadCount();
    return response.status(200).json(result);
  }

  async markAsViewed(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);
    const result = await rentalApplicationService.markAsViewed({
      applicationId: params.id,
    });
    return response.status(200).json(result);
  }
}
