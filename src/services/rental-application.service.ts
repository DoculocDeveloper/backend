// Libs
import { prisma } from "../lib/prisma.js";

// Errors
import { AppError } from "../middlewares/error-handler.js";

// Services
import { CreditService } from "./credit.service.js";
import { oragoClient } from "./orago-client.js";

// Utils
import { extractApplicantName } from "../utils/extract-applicant-name.js";
import { evaluateTenant } from "../utils/evaluate-tenant.js";

const creditService = new CreditService();

type CreateByCpfInput = {
  requesterId: string;
  cpf: string;
  email?: string;
  phone?: string;
  selfie?: string;
  rentValue: number;
  condominiumValue: number;
  feesValue: number;
};

type CreateByCnpjInput = {
  requesterId: string;
  cnpj: string;
  rentValue: number;
  condominiumValue: number;
  feesValue: number;
};

function mapDecisionStatus(status: string) {
  if (status === "approved") return "APPROVED";
  if (status === "rejected") return "REJECTED";
  return "MANUAL_REVIEW";
}

function mapRecommendationStatus(status: string) {
  if (status === "recommended") return "RECOMMENDED";
  if (status === "not_recommended") return "NOT_RECOMMENDED";
  return "UNKNOWN";
}

function getInitialWorkflowStatus(decisionStatus: string) {
  if (decisionStatus === "APPROVED") return "WAITING_CONTRACT_DATA";
  if (decisionStatus === "REJECTED") return "REJECTED";
  return "CONSULTED";
}

async function tryCollectOragoWithRetry(analysisId: string) {
  const attempts = 3;
  const delayMs = 3600;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await oragoClient.collectAnalysis(analysisId);

      console.log("[ORAGO_COLLECT_ATTEMPT]", {
        analysisId,
        attempt,
        ready: response?.ready,
        error: response?.error,
        message: response?.message,
        status: response?.status,
      });

      if (response && !response.error && response.ready) {
        return response;
      }
    } catch (error) {
      console.error("[ORAGO_COLLECT_ERROR]", {
        analysisId,
        attempt,
        error,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

export class RentalApplicationService {
  private async createApplicationAndConsumeCredit(params: {
    requesterId: string;
    data: Parameters<typeof prisma.rentalApplication.create>[0]["data"];
  }) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.userCreditWallet.findUnique({
        where: { userId: params.requesterId },
      });

      if (!wallet) {
        throw new AppError(403, "Carteira de créditos não encontrada");
      }

      if (!wallet.isVip && wallet.availableCredits <= 0) {
        throw new AppError(402, "Usuário sem consultas disponíveis");
      }

      const createdApplication = await tx.rentalApplication.create({
        data: params.data,
      });

      if (wallet.isVip) {
        await tx.creditLedger.create({
          data: {
            userId: params.requesterId,
            type: "CONSULT_USED",
            amount: 0,
            balanceAfter: wallet.availableCredits,
            reason: `Consulta realizada como VIP. Application: ${createdApplication.id}`,
          },
        });

        return createdApplication;
      }

      const updatedWallet = await tx.userCreditWallet.update({
        where: { userId: params.requesterId },
        data: {
          availableCredits: {
            decrement: 1,
          },
        },
      });

      await tx.creditLedger.create({
        data: {
          userId: params.requesterId,
          type: "CONSULT_USED",
          amount: -1,
          balanceAfter: updatedWallet.availableCredits,
          reason: `Crédito consumido na consulta. Application: ${createdApplication.id}`,
        },
      });

      return createdApplication;
    });
  }

  private async assertDocumentWasNotConsulted(document: string) {
    const existingApplication = await prisma.rentalApplication.findUnique({
      where: {
        document,
      },
      select: {
        id: true,
        document: true,
        documentType: true,
        createdAt: true,
        status: true,
      },
    });

    if (existingApplication) {
      throw new AppError(
        409,
        "Este CPF/CNPJ já possui uma consulta cadastrada. Não é permitido consultar o mesmo documento novamente.",
        "DOCUMENT_ALREADY_CONSULTED",
      );
    }
  }

  private async createConsultLock(params: {
    requesterId: string;
    document: string;
    documentType: "CPF" | "CNPJ";
    rentValue: number;
    condominiumValue: number;
    feesValue: number;
  }) {
    try {
      return await prisma.oragoConsultLock.create({
        data: {
          requesterId: params.requesterId,
          document: params.document,
          documentType: params.documentType,
          status: "PROCESSING",
          rentValue: params.rentValue,
          condominiumValue: params.condominiumValue,
          feesValue: params.feesValue,
        },
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        throw new AppError(
          409,
          "Este CPF/CNPJ já possui uma consulta em processamento ou já foi consultado.",
          "DOCUMENT_CONSULT_IN_PROGRESS",
        );
      }

      throw error;
    }
  }

  private async finalizeOragoConsult(params: {
    lockId: string;
    requesterId: string;
    documentType: "CPF" | "CNPJ";
    document: string;
    oragoAnalysisId: string;
    collectResponse: any;
    rentValue: number;
    condominiumValue: number;
    feesValue: number;
  }) {
    const existingApplication = await prisma.rentalApplication.findUnique({
      where: {
        document: params.document,
      },
    });

    if (existingApplication) {
      await prisma.oragoConsultLock.update({
        where: {
          id: params.lockId,
        },
        data: {
          status: "COMPLETED",
          errorMessage: null,
        },
      });

      return {
        application: existingApplication,
        decision: null,
      };
    }

    const decision = evaluateTenant({
      documentType: params.documentType,
      oragoData: params.collectResponse.data,
      input: {
        rentValue: params.rentValue,
        condominiumValue: params.condominiumValue,
        feesValue: params.feesValue,
      },
    });

    const tenantName = extractApplicantName(
      params.documentType,
      params.collectResponse.data,
    );

    const automaticDecision = mapDecisionStatus(decision.status);
    const recommendation = mapRecommendationStatus(decision.recommendation);
    const workflowStatus = getInitialWorkflowStatus(automaticDecision);

    const application = await this.createApplicationAndConsumeCredit({
      requesterId: params.requesterId,
      data: {
        documentType: params.documentType,
        document: params.document,
        requesterId: params.requesterId,

        tenantName,
        tenantDocument: params.document,

        oragoAnalysisId: params.oragoAnalysisId,
        oragoRawResponse: JSON.stringify(params.collectResponse),
        oragoData: JSON.stringify(params.collectResponse.data),

        rentValue: params.rentValue,
        condominiumValue: params.condominiumValue,
        feesValue: params.feesValue,
        requestedExpense: decision.requestedExpense,

        automaticDecision,
        recommendation,

        housingExpenseMin: decision.housingExpense.min,
        housingExpenseMax: decision.housingExpense.max,

        decisionReasons: JSON.stringify(decision.reasons),
        decisionMetadata: decision.metadata
          ? JSON.stringify(decision.metadata)
          : null,

        status: workflowStatus,
      },
    });

    await prisma.oragoConsultLock.update({
      where: {
        id: params.lockId,
      },
      data: {
        status: "COMPLETED",
        errorMessage: null,
      },
    });

    return {
      application,
      decision,
    };
  }

  async createByCpf(input: CreateByCpfInput) {
    await this.assertDocumentWasNotConsulted(input.cpf);

    await creditService.ensureCanConsult(input.requesterId);

    const lock = await this.createConsultLock({
      requesterId: input.requesterId,
      document: input.cpf,
      documentType: "CPF",
      rentValue: input.rentValue,
      condominiumValue: input.condominiumValue,
      feesValue: input.feesValue,
    });

    try {
      const oragoCreateResponse = await oragoClient.createPfAnalysis({
        cpf: input.cpf,
        email: input.email,
        phone: input.phone,
        selfie: input.selfie,
        products: {
          basic_data: true,
          default_financial: true,
          judicial: true,
          ai: true,
          antifraud: false,
          antifraud_pix: false,
          antifraud_quiz: false,
          banking_history: false,
          advanced_financial: false,
          pre_visit: false,
          pre_visit_judicial: false,
          financial_open_finance: false,
          biometrics_with_liveness: false,
        },
      });

      await prisma.oragoConsultLock.update({
        where: {
          id: lock.id,
        },
        data: {
          oragoAnalysisId: oragoCreateResponse.analysis_id,
        },
      });

      const collectResponse = await tryCollectOragoWithRetry(
        oragoCreateResponse.analysis_id,
      );

      if (!collectResponse) {
        return {
          pending: true,
          status: "PROCESSING",
          consultLockId: lock.id,
          document: input.cpf,
          documentType: "CPF",
          message:
            "A consulta foi criada na Órago e ainda está em processamento. Consulte o status em alguns instantes.",
        };
      }

      return this.finalizeOragoConsult({
        lockId: lock.id,
        requesterId: input.requesterId,
        documentType: "CPF",
        document: input.cpf,
        oragoAnalysisId: oragoCreateResponse.analysis_id,
        collectResponse,
        rentValue: input.rentValue,
        condominiumValue: input.condominiumValue,
        feesValue: input.feesValue,
      });
    } catch (error: any) {
      const currentLock = await prisma.oragoConsultLock.findUnique({
        where: {
          id: lock.id,
        },
      });

      if (!currentLock?.oragoAnalysisId) {
        await prisma.oragoConsultLock
          .delete({
            where: {
              id: lock.id,
            },
          })
          .catch(() => null);
      } else {
        const existingApplication = await prisma.rentalApplication.findUnique({
          where: {
            document: input.cpf,
          },
          select: {
            id: true,
          },
        });

        await prisma.oragoConsultLock.update({
          where: { id: lock.id },
          data: {
            status: existingApplication ? "COMPLETED" : "FAILED",
            errorMessage: existingApplication
              ? null
              : (error?.message ?? "Erro ao processar consulta Órago"),
          },
        });
      }

      throw error;
    }
  }

  async createByCnpj(input: CreateByCnpjInput) {
    await this.assertDocumentWasNotConsulted(input.cnpj);

    await creditService.ensureCanConsult(input.requesterId);

    const lock = await this.createConsultLock({
      requesterId: input.requesterId,
      document: input.cnpj,
      documentType: "CNPJ",
      rentValue: input.rentValue,
      condominiumValue: input.condominiumValue,
      feesValue: input.feesValue,
    });

    try {
      const oragoCreateResponse = await oragoClient.createPjAnalysis({
        cnpj: input.cnpj,
        products: {
          company_analysis_judicial: true,
          company_analysis_financial: true,
          ai: true,
        },
      });

      await prisma.oragoConsultLock.update({
        where: { id: lock.id },
        data: {
          oragoAnalysisId: oragoCreateResponse.analysis_id,
        },
      });

      const collectResponse = await tryCollectOragoWithRetry(
        oragoCreateResponse.analysis_id,
      );

      if (!collectResponse) {
        return {
          pending: true,
          status: "PROCESSING",
          consultLockId: lock.id,
          document: input.cnpj,
          documentType: "CNPJ",
          message:
            "A consulta foi criada na Órago e ainda está em processamento. Consulte o status em alguns instantes.",
        };
      }

      return this.finalizeOragoConsult({
        lockId: lock.id,
        requesterId: input.requesterId,
        documentType: "CNPJ",
        document: input.cnpj,
        oragoAnalysisId: oragoCreateResponse.analysis_id,
        collectResponse,
        rentValue: input.rentValue,
        condominiumValue: input.condominiumValue,
        feesValue: input.feesValue,
      });
    } catch (error: any) {
      const currentLock = await prisma.oragoConsultLock.findUnique({
        where: {
          id: lock.id,
        },
      });

      if (!currentLock?.oragoAnalysisId) {
        await prisma.oragoConsultLock
          .delete({
            where: {
              id: lock.id,
            },
          })
          .catch(() => null);
      } else {
        const existingApplication = await prisma.rentalApplication.findUnique({
          where: {
            document: input.cnpj,
          },
          select: {
            id: true,
          },
        });

        await prisma.oragoConsultLock.update({
          where: { id: lock.id },
          data: {
            status: existingApplication ? "COMPLETED" : "FAILED",
            errorMessage: existingApplication
              ? null
              : (error?.message ?? "Erro ao processar consulta Órago"),
          },
        });
      }

      throw error;
    }
  }

  async getConsultStatus(params: {
    consultLockId: string;
    requesterId: string;
    role: string;
  }) {
    const lock = await prisma.oragoConsultLock.findUnique({
      where: {
        id: params.consultLockId,
      },
    });

    if (!lock) {
      throw new AppError(404, "Consulta em processamento não encontrada");
    }

    if (params.role !== "ADMIN" && lock.requesterId !== params.requesterId) {
      throw new AppError(403, "Acesso negado");
    }

    const existingApplication = await prisma.rentalApplication.findUnique({
      where: {
        document: lock.document,
      },
    });

    if (existingApplication) {
      await prisma.oragoConsultLock.update({
        where: {
          id: lock.id,
        },
        data: {
          status: "COMPLETED",
          errorMessage: null,
        },
      });

      return {
        status: "COMPLETED",
        application: existingApplication,
        decision: null,
      };
    }

    if (lock.status === "FAILED") {
      return {
        status: "FAILED",
        message: lock.errorMessage ?? "A consulta falhou.",
      };
    }

    if (!lock.oragoAnalysisId) {
      return {
        status: "PROCESSING",
        consultLockId: lock.id,
        message: "Consulta ainda aguardando identificação da análise na Órago.",
      };
    }

    if (
      lock.rentValue === null ||
      lock.condominiumValue === null ||
      lock.feesValue === null
    ) {
      throw new AppError(
        400,
        "Consulta antiga sem valores locatícios salvos. Refaça a consulta em ambiente de teste.",
        "ORAGO_LOCK_WITHOUT_VALUES",
      );
    }

    const collectResponse = await tryCollectOragoWithRetry(
      lock.oragoAnalysisId,
    );

    if (!collectResponse) {
      return {
        status: "PROCESSING",
        consultLockId: lock.id,
        message: "A análise ainda está em processamento na Órago.",
      };
    }

    const result = await this.finalizeOragoConsult({
      lockId: lock.id,
      requesterId: lock.requesterId,
      documentType: lock.documentType,
      document: lock.document,
      oragoAnalysisId: lock.oragoAnalysisId,
      collectResponse,
      rentValue: Number(lock.rentValue),
      condominiumValue: Number(lock.condominiumValue),
      feesValue: Number(lock.feesValue),
    });

    return {
      status: "COMPLETED",
      ...result,
    };
  }

  async fillContractData(params: {
    applicationId: string;
    requesterId: string;
    data: {
      tenantName: string;
      tenantDocument: string;
      tenantEmail: string;
      tenantPhone: string;
      propertyZipCode: string;
      propertyStreet: string;
      propertyNumber: string;
      propertyComplement?: string;
      propertyNeighborhood: string;
      propertyCity: string;
      propertyState: string;
    };
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.requesterId !== params.requesterId) {
      throw new AppError(403, "Acesso negado");
    }

    const tenantDocument = params.data.tenantDocument.replace(/\D/g, "");

    if (tenantDocument !== application.document) {
      throw new AppError(
        400,
        "O documento do locatário deve ser o mesmo utilizado na consulta.",
        "TENANT_DOCUMENT_MISMATCH",
      );
    }

    const canFillContractData = application.status === "WAITING_CONTRACT_DATA";

    if (!canFillContractData) {
      throw new AppError(
        400,
        "Essa consulta ainda não está liberada para preenchimento dos dados do contrato",
      );
    }

    const updatedApplication = await prisma.rentalApplication.update({
      where: { id: params.applicationId },
      data: {
        ...params.data,
        status: "WAITING_ADMIN_CONTRACT",
      },
    });

    await prisma.contract.upsert({
      where: {
        applicationId: params.applicationId,
      },
      create: {
        applicationId: params.applicationId,
        status: "PENDING",
        templateName: "default-rental-contract.docx",
      },
      update: {
        status: "PENDING",
      },
    });

    return updatedApplication;
  }

  async contest(params: {
    applicationId: string;
    requesterId: string;
    reason: string;
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.requesterId !== params.requesterId) {
      throw new AppError(403, "Acesso negado");
    }

    if (application.status !== "REJECTED") {
      throw new AppError(
        400,
        "Somente consultas rejeitadas podem ser contestadas",
      );
    }

    const openContest = await prisma.rentalApplicationContest.findFirst({
      where: {
        applicationId: params.applicationId,
        status: "OPEN",
      },
    });

    if (openContest) {
      throw new AppError(
        409,
        "Já existe uma contestação aberta para esta consulta",
      );
    }

    const contest = await prisma.$transaction(async (tx) => {
      const createdContest = await tx.rentalApplicationContest.create({
        data: {
          applicationId: params.applicationId,
          createdById: params.requesterId,
          reason: params.reason,
        },
      });

      await tx.rentalApplication.update({
        where: {
          id: params.applicationId,
        },
        data: {
          status: "CONTESTED",
        },
      });

      return createdContest;
    });

    return contest;
  }

  async adminDecide(params: {
    applicationId: string;
    adminId: string;
    decision: "APPROVED" | "REJECTED";
    reason?: string;
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    const nextStatus =
      params.decision === "APPROVED"
        ? "WAITING_CONTRACT_DATA"
        : "ADMIN_REJECTED";

    const updatedApplication = await prisma.$transaction(async (tx) => {
      const updated = await tx.rentalApplication.update({
        where: {
          id: params.applicationId,
        },
        data: {
          adminDecision: params.decision,
          adminDecisionById: params.adminId,
          adminDecisionAt: new Date(),
          adminDecisionReason: params.reason,
          status: nextStatus,
        },
      });

      await tx.rentalApplicationContest.updateMany({
        where: {
          applicationId: params.applicationId,
          status: "OPEN",
        },
        data: {
          status: params.decision === "APPROVED" ? "ACCEPTED" : "REJECTED",
          reviewedById: params.adminId,
          reviewedAt: new Date(),
          adminNote: params.reason,
        },
      });

      return updated;
    });

    return updatedApplication;
  }
}
