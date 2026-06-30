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

    return response.status(201).json(result);
  }

  async list(request: Request, response: Response) {
    const query = listRentalApplicationsSchema.parse(request.query);

    const where =
      request.user!.role === UserRole.ADMIN
        ? {
            requesterId: query.requesterId,
            status: query.status,
            document: query.document,
          }
        : {
            requesterId: request.user!.id,
            status: query.status,
            document: query.document,
          };

    const [applications, total] = await Promise.all([
      prisma.rentalApplication.findMany({
        where,
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: {
          createdAt: "desc",
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
                  name: true,
                  cnpj: true,
                  phone: true,
                  responsibleName: true,
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
        },
      }),
      prisma.rentalApplication.count({ where }),
    ]);

    return response.json({
      applications: applications.map((application) => ({
        ...application,
        decisionReasons: JSON.parse(application.decisionReasons),
        decisionMetadata: application.decisionMetadata
          ? JSON.parse(application.decisionMetadata)
          : null,
      })),
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
                name: true,
                cnpj: true,
                phone: true,
                responsibleName: true,
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
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (
      request.user!.role !== UserRole.ADMIN &&
      application.requesterId !== request.user!.id
    ) {
      throw new AppError(403, "Acesso negado");
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

    return response.json({
      application: {
        ...application,
        tenantName,
        tenantDocument,
        tenants,
        decisionReasons: JSON.parse(application.decisionReasons),
        decisionMetadata: application.decisionMetadata
          ? JSON.parse(application.decisionMetadata)
          : null,
        oragoRawResponse: undefined,
        oragoData: undefined,
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

    return response.json({ application });
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

  async delete(request: Request, response: Response) {
    const params = rentalApplicationParamsSchema.parse(request.params);

    await rentalApplicationService.deleteApplication({
      applicationId: params.id,
      requesterId: request.user!.id,
      role: request.user!.role,
    });

    return response.status(204).send();
  }
}
