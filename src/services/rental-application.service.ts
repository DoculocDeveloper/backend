// Libs
import { RecommendationStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Errors
import { AppError } from "../middlewares/error-handler.js";

// Services
import { CreditService } from "./credit.service.js";
import { oragoClient } from "./orago-client.js";
import { ClicksignClient } from "./clicksign-client.js";

// Utils
import { extractApplicantName } from "../utils/extract-applicant-name.js";
import { evaluateTenant } from "../utils/evaluate-tenant.js";
import { parseCurrencyRange } from "../utils/parse-currency-range.js";

const creditService = new CreditService();
const clicksignClient = new ClicksignClient();

type CreateByCpfInput = {
  requesterId: string;
  cpf: string;
  secondCpf?: string | null;
  additionalCpfs?: string[] | null;
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Erro desconhecido";
  }
}

function mapDecisionStatus(status: string) {
  if (status === "approved") return "APPROVED";
  if (status === "rejected") return "REJECTED";
  return "MANUAL_REVIEW";
}

function mapRecommendationStatus(status: string): RecommendationStatus {
  if (status === "recommended") return RecommendationStatus.RECOMMENDED;
  if (status === "not_recommended") return RecommendationStatus.NOT_RECOMMENDED;
  return RecommendationStatus.UNKNOWN;
}

function getInitialWorkflowStatus(
  decisionStatus: string,
  recommendationStatus?: string,
) {
  if (decisionStatus === "APPROVED") return "WAITING_CONTRACT_DATA";
  if (decisionStatus === "REJECTED") return "REJECTED";
  if (recommendationStatus === "RECOMMENDED") return "REJECTED";
  return "CONSULTED";
}

async function tryCollectOragoWithRetry(
  analysisId: string,
  options?: { attempts?: number; delayMs?: number },
) {
  const attempts = options?.attempts ?? 3;
  const delayMs = options?.delayMs ?? 3000;

  let lastResponse: any = null;
  let lastFatalError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await oragoClient.collectAnalysis(analysisId);

      lastResponse = response;

      console.log("[ORAGO_COLLECT_ATTEMPT]", {
        analysisId,
        attempt,
        ready: response?.ready,
        error: response?.error,
        message: response?.message,
        status: response?.status,
        hasData: Boolean(response?.data),
      });

      if (response?.error === false && response?.ready === true) {
        return response;
      }

      if (response?.error === true) {
        lastFatalError = new AppError(
          502,
          response?.message ?? "Erro retornado pela Órago ao coletar análise.",
          "ORAGO_COLLECT_RETURNED_ERROR",
        );
        break;
      }
    } catch (error) {
      console.warn("[ORAGO_COLLECT_ATTEMPT_WARNING]", {
        analysisId,
        attempt,
        message: getErrorMessage(error),
      });

      if (
        error instanceof AppError &&
        error.code === "ORAGO_COLLECT_RETURNED_ERROR"
      ) {
        lastFatalError = error;
        break;
      }
    }

    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastFatalError) {
    throw lastFatalError;
  }

  console.log("[ORAGO_COLLECT_NOT_READY]", {
    analysisId,
    lastReady: lastResponse?.ready,
    lastError: lastResponse?.error,
    lastMessage: lastResponse?.message,
    lastStatus: lastResponse?.status,
    hasData: Boolean(lastResponse?.data),
  });

  return null;
}

export const UNREAD_NOTIFICATIONS_CUTOFF_DATE = new Date("2026-10-21T11:48:00.000Z");

export class RentalApplicationService {
  private async createApplicationAndConsumeCredit(params: {
    requesterId: string;
    data: Parameters<typeof prisma.rentalApplication.create>[0]["data"];
    creditsToConsume?: number;
  }) {
    const creditsToConsume = params.creditsToConsume ?? 1;

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.userCreditWallet.findUnique({
        where: { userId: params.requesterId },
      });

      if (!wallet) {
        throw new AppError(403, "Carteira de créditos não encontrada");
      }

      if (!wallet.isVip && wallet.availableCredits < creditsToConsume) {
        throw new AppError(
          402,
          creditsToConsume > 1
            ? `Você precisa de pelo menos ${creditsToConsume} consultas disponíveis para realizar esta análise conjunta.`
            : "Usuário sem consultas disponíveis",
        );
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
            decrement: creditsToConsume,
          },
        },
      });

      await tx.creditLedger.create({
        data: {
          userId: params.requesterId,
          type: "CONSULT_USED",
          amount: -creditsToConsume,
          balanceAfter: updatedWallet.availableCredits,
          reason: `${creditsToConsume} crédito(s) consumido(s) na consulta. Application: ${createdApplication.id}`,
        },
      });

      return createdApplication;
    });
  }

  private async assertDocumentWasNotConsulted(document: string) {
    const digits = document.replace(/\D/g, "");
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

    const existingTenant = await prisma.rentalApplicationTenant.findFirst({
      where: {
        document: {
          contains: digits,
        },
      },
      select: {
        id: true,
        applicationId: true,
      },
    });

    if (existingApplication || existingTenant) {
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
    secondDocument?: string | null;
    additionalDocuments?: string | null;
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
          secondDocument: params.secondDocument,
          additionalDocuments: params.additionalDocuments,
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
    email?: string;
    phone?: string;
  }) {
    const existingApplication = await prisma.rentalApplication.findUnique({
      where: {
        document: params.document,
      },
      include: {
        tenants: {
          orderBy: { order: "asc" },
        },
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
    const workflowStatus = getInitialWorkflowStatus(
      automaticDecision,
      recommendation,
    );

    const incomeRange = parseCurrencyRange(
      params.collectResponse.data?.financial?.presumed_income,
    );
    const presumedIncome = incomeRange.max ?? incomeRange.min ?? null;

    const application = await this.createApplicationAndConsumeCredit({
      requesterId: params.requesterId,
      creditsToConsume: 1,
      data: {
        documentType: params.documentType,
        document: params.document,
        requesterId: params.requesterId,

        tenantName,
        tenantDocument: params.document,
        tenantEmail: params.email ?? null,
        tenantPhone: params.phone ?? null,

        oragoAnalysisId: params.oragoAnalysisId,
        oragoRawResponse: JSON.stringify(params.collectResponse),
        oragoData: JSON.stringify(params.collectResponse.data),

        products: JSON.stringify(params.collectResponse.products ?? null),

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
        isJointApplication: false,
        totalPresumedIncome: presumedIncome,

        tenants: {
          create: [
            {
              order: 1,
              name:
                tenantName ||
                (params.documentType === "CPF"
                  ? "Locatário Principal"
                  : "Empresa Locatária"),
              document: params.document,
              email: params.email ?? "",
              phone: params.phone ?? "",
              oragoAnalysisId: params.oragoAnalysisId,
              oragoData: JSON.stringify(params.collectResponse.data),
              presumedIncome,
              incomePercentage: 100,
              isPrimaryIncome: true,
              recommendation,
              decisionReasons: JSON.stringify(decision.reasons),
            },
          ],
        },
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

  private async finalizeJointOragoConsult(params: {
    lockId: string;
    requesterId: string;
    document: string;
    rentValue: number;
    condominiumValue: number;
    feesValue: number;
    email?: string;
    phone?: string;
    tenants: Array<{
      order: number;
      document: string;
      oragoAnalysisId: string;
      collectResponse: any;
      email?: string;
      phone?: string;
    }>;
  }) {
    const existingApplication = await prisma.rentalApplication.findUnique({
      where: {
        document: params.document,
      },
      include: {
        tenants: {
          orderBy: { order: "asc" },
        },
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

    const requestedExpense =
      params.rentValue + params.condominiumValue + params.feesValue;

    const evaluatedTenants = params.tenants.map((item, idx) => {
      const decision = evaluateTenant({
        documentType: "CPF",
        oragoData: item.collectResponse.data,
        input: {
          rentValue: params.rentValue,
          condominiumValue: params.condominiumValue,
          feesValue: params.feesValue,
        },
      });
      const tenantName =
        extractApplicantName("CPF", item.collectResponse.data) ||
        `Locatário ${idx + 1}`;
      const incomeRange = parseCurrencyRange(
        item.collectResponse.data?.financial?.presumed_income,
      );
      const income = incomeRange.max ?? incomeRange.min ?? 0;
      const rec = mapRecommendationStatus(decision.recommendation);

      return {
        order: item.order,
        document: item.document,
        name: tenantName,
        oragoAnalysisId: item.oragoAnalysisId,
        collectResponse: item.collectResponse,
        decision,
        incomeRange,
        income,
        recommendation: rec,
        email: item.email ?? "",
        phone: item.phone ?? "",
      };
    });

    // Composição de Renda
    const totalPresumedIncome = evaluatedTenants.reduce(
      (acc, t) => acc + t.income,
      0,
    );

    let maxIncome = -1;
    let primaryOrder = 1;
    for (const t of evaluatedTenants) {
      if (t.income > maxIncome) {
        maxIncome = t.income;
        primaryOrder = t.order;
      }
    }

    const enrichedTenants = evaluatedTenants.map((t) => {
      const isPrimary = t.order === primaryOrder;
      const percentage =
        totalPresumedIncome > 0
          ? (t.income / totalPresumedIncome) * 100
          : 100 / evaluatedTenants.length;
      return {
        ...t,
        isPrimaryIncome: isPrimary,
        incomePercentage: percentage,
      };
    });

    const combinedIncomeMin = evaluatedTenants.reduce(
      (acc, t) => acc + (t.incomeRange.min ?? 0),
      0,
    );
    const combinedIncomeMax = evaluatedTenants.reduce(
      (acc, t) => acc + (t.incomeRange.max ?? 0),
      0,
    );
    const combinedHousingExpenseMin =
      combinedIncomeMin > 0 ? combinedIncomeMin * 0.3 : null;
    const combinedHousingExpenseMax =
      combinedIncomeMax > 0 ? combinedIncomeMax * 0.3 : null;

    // Matriz de Decisão:
    const allRecommended = enrichedTenants.every(
      (t) => t.decision.recommendation === "recommended",
    );
    const allNotRecommended = enrichedTenants.every(
      (t) => t.decision.recommendation === "not_recommended",
    );

    let automaticDecision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW" =
      "MANUAL_REVIEW";
    let recommendation: "RECOMMENDED" | "NOT_RECOMMENDED" | "UNKNOWN" =
      "UNKNOWN";
    let workflowStatus: "WAITING_CONTRACT_DATA" | "REJECTED" | "CONSULTED" =
      "CONSULTED";
    let reasons: string[] = [];

    if (allRecommended) {
      if (
        combinedHousingExpenseMax &&
        requestedExpense <= combinedHousingExpenseMax
      ) {
        automaticDecision = "APPROVED";
        recommendation = "RECOMMENDED";
        workflowStatus = "WAITING_CONTRACT_DATA";
        reasons = [
          `Todos os ${enrichedTenants.length} locatários foram recomendados pela Órago e a renda combinada cobre a despesa locatícia.`,
        ];
      } else {
        automaticDecision = "MANUAL_REVIEW";
        recommendation = "UNKNOWN";
        workflowStatus = "CONSULTED";
        reasons = [
          `Todos os locatários foram recomendados, mas a despesa de R$ ${requestedExpense.toFixed(
            2,
          )} excede o limite somado de moradia de R$ ${(
            combinedHousingExpenseMax ?? 0
          ).toFixed(2)}.`,
        ];
      }
    } else if (allNotRecommended) {
      automaticDecision = "REJECTED";
      recommendation = "NOT_RECOMMENDED";
      workflowStatus = "REJECTED";
      reasons = [
        `Todos os ${enrichedTenants.length} locatários retornaram como não recomendados na análise Órago.`,
      ];
    } else {
      automaticDecision = "MANUAL_REVIEW";
      recommendation = "UNKNOWN";
      workflowStatus = "CONSULTED";
      const pointedTenants = enrichedTenants
        .filter((t) => t.decision.recommendation !== "recommended")
        .map((t) => t.name)
        .join(", ");
      reasons = [
        `Composição com apontamento: ${pointedTenants} possui(em) apontamentos na Órago. Enviado para análise manual Doculoc.`,
      ];
    }

    const primaryTenant =
      enrichedTenants.find((t) => t.isPrimaryIncome) ?? enrichedTenants[0];

    const application = await this.createApplicationAndConsumeCredit({
      requesterId: params.requesterId,
      creditsToConsume: enrichedTenants.length,
      data: {
        documentType: "CPF",
        document: params.document,
        requesterId: params.requesterId,

        tenantName: enrichedTenants[0].name,
        tenantDocument: params.document,
        tenantEmail: params.email,
        tenantPhone: params.phone,

        oragoAnalysisId: enrichedTenants[0].oragoAnalysisId,
        oragoRawResponse: JSON.stringify(enrichedTenants[0].collectResponse),
        oragoData: JSON.stringify(primaryTenant.collectResponse.data),

        products: JSON.stringify({
          basic_data: true,
          default_financial: true,
          judicial: true,
          ai: true,
        }),

        rentValue: params.rentValue,
        condominiumValue: params.condominiumValue,
        feesValue: params.feesValue,
        requestedExpense,

        automaticDecision,
        recommendation,

        housingExpenseMin: combinedHousingExpenseMin,
        housingExpenseMax: combinedHousingExpenseMax,

        decisionReasons: JSON.stringify(reasons),
        decisionMetadata: JSON.stringify({
          isJointApplication: true,
          tenants: enrichedTenants.map((t) => ({
            order: t.order,
            name: t.name,
            document: t.document,
            income: t.income,
            incomePercentage: t.incomePercentage,
            isPrimaryIncome: t.isPrimaryIncome,
            recommendation: t.recommendation,
            decisionReasons: t.decision.reasons,
          })),
          combinedIncome: {
            total: totalPresumedIncome,
            min: combinedIncomeMin,
            max: combinedIncomeMax,
            housingExpenseMax: combinedHousingExpenseMax,
          },
        }),

        status: workflowStatus,
        isJointApplication: true,
        totalPresumedIncome,

        tenants: {
          create: enrichedTenants.map((t) => ({
            order: t.order,
            name: t.name,
            document: t.document,
            email: t.email,
            phone: t.phone,
            oragoAnalysisId: t.oragoAnalysisId,
            oragoData: JSON.stringify(t.collectResponse.data),
            presumedIncome: t.income,
            incomePercentage: t.incomePercentage,
            isPrimaryIncome: t.isPrimaryIncome,
            recommendation: t.recommendation,
            decisionReasons: JSON.stringify(t.decision.reasons),
          })),
        },
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
      decision: {
        status: automaticDecision,
        recommendation,
        requestedExpense,
        housingExpense: {
          min: combinedHousingExpenseMin,
          max: combinedHousingExpenseMax,
        },
        reasons,
      },
    };
  }

  async createByCpf(input: CreateByCpfInput) {
    const extraCpfs: string[] = [];
    if (input.additionalCpfs && input.additionalCpfs.length > 0) {
      for (const c of input.additionalCpfs) {
        const cleaned = c.replace(/\D/g, "");
        if (cleaned && cleaned !== input.cpf && !extraCpfs.includes(cleaned)) {
          extraCpfs.push(cleaned);
        }
      }
    } else if (input.secondCpf) {
      const cleaned = input.secondCpf.replace(/\D/g, "");
      if (cleaned && cleaned !== input.cpf) {
        extraCpfs.push(cleaned);
      }
    }

    const allCpfs = [input.cpf, ...extraCpfs];
    const isJoint = allCpfs.length > 1;

    for (const doc of allCpfs) {
      await this.assertDocumentWasNotConsulted(doc);
    }

    const creditsNeeded = allCpfs.length;
    await creditService.ensureCanConsult(input.requesterId, creditsNeeded);

    const existingLock = await prisma.oragoConsultLock.findUnique({
      where: {
        document: input.cpf,
      },
      select: {
        id: true,
        requesterId: true,
        status: true,
        document: true,
        secondDocument: true,
        documentType: true,
      },
    });

    let lock: any = null;

    if (existingLock) {
      if (
        existingLock.requesterId === input.requesterId &&
        existingLock.status === "PROCESSING"
      ) {
        return {
          pending: true,
          status: "PROCESSING",
          consultLockId: existingLock.id,
          document: existingLock.document,
          documentType: existingLock.documentType,
          message:
            "Esta consulta já está em processamento. Acompanhando o status da análise.",
        };
      }

      if (
        existingLock.requesterId === input.requesterId &&
        existingLock.status === "FAILED"
      ) {
        lock = await prisma.oragoConsultLock.update({
          where: { id: existingLock.id },
          data: {
            status: "PROCESSING",
            errorMessage: null,
            oragoAnalysisId: null,
            secondOragoAnalysisId: null,
            secondDocument: extraCpfs[0] ?? null,
            additionalDocuments:
              extraCpfs.length > 0 ? JSON.stringify(extraCpfs) : null,
            additionalOragoAnalysisIds: null,
            rentValue: input.rentValue,
            condominiumValue: input.condominiumValue,
            feesValue: input.feesValue,
          },
        });
      } else {
        throw new AppError(
          409,
          "Este CPF/CNPJ já possui uma consulta em processamento ou já foi consultado.",
          "DOCUMENT_CONSULT_IN_PROGRESS",
        );
      }
    } else {
      lock = await this.createConsultLock({
        requesterId: input.requesterId,
        document: input.cpf,
        secondDocument: extraCpfs[0] ?? null,
        additionalDocuments:
          extraCpfs.length > 0 ? JSON.stringify(extraCpfs) : null,
        documentType: "CPF",
        rentValue: input.rentValue,
        condominiumValue: input.condominiumValue,
        feesValue: input.feesValue,
      });
    }

    const oragoProducts = {
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
    };

    try {
      if (!isJoint) {
        const oragoCreateResponse = await oragoClient.createPfAnalysis({
          cpf: input.cpf,
          email: input.email,
          phone: input.phone,
          selfie: input.selfie,
          products: oragoProducts,
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
          { attempts: 1, delayMs: 0 },
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
          email: input.email,
          phone: input.phone,
        });
      } else {
        // Fluxo com múltiplos CPFs (Composição de Renda)
        const oragoCreateResponses = await Promise.all(
          allCpfs.map((cpf, idx) =>
            oragoClient.createPfAnalysis({
              cpf,
              email: idx === 0 ? input.email : undefined,
              phone: idx === 0 ? input.phone : undefined,
              selfie: idx === 0 ? input.selfie : undefined,
              products: oragoProducts,
            }),
          ),
        );

        const extraAnalysisIds = oragoCreateResponses
          .slice(1)
          .map((r) => r.analysis_id);

        await prisma.oragoConsultLock.update({
          where: {
            id: lock.id,
          },
          data: {
            oragoAnalysisId: oragoCreateResponses[0].analysis_id,
            secondOragoAnalysisId: extraAnalysisIds[0] ?? null,
            additionalOragoAnalysisIds: JSON.stringify(extraAnalysisIds),
          },
        });

        const collectResponses = await Promise.all(
          oragoCreateResponses.map((r) =>
            tryCollectOragoWithRetry(r.analysis_id, {
              attempts: 1,
              delayMs: 0,
            }),
          ),
        );

        if (collectResponses.some((res) => !res)) {
          return {
            pending: true,
            status: "PROCESSING",
            consultLockId: lock.id,
            document: input.cpf,
            documentType: "CPF",
            message:
              "As análises foram criadas na Órago e ainda estão em processamento. Consulte o status em alguns instantes.",
          };
        }

        return this.finalizeJointOragoConsult({
          lockId: lock.id,
          requesterId: input.requesterId,
          document: input.cpf,
          rentValue: input.rentValue,
          condominiumValue: input.condominiumValue,
          feesValue: input.feesValue,
          email: input.email,
          phone: input.phone,
          tenants: allCpfs.map((cpf, idx) => ({
            order: idx + 1,
            document: cpf,
            oragoAnalysisId: oragoCreateResponses[idx].analysis_id,
            collectResponse: collectResponses[idx],
            email: idx === 0 ? input.email : undefined,
            phone: idx === 0 ? input.phone : undefined,
          })),
        });
      }
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

    const existingLock = await prisma.oragoConsultLock.findUnique({
      where: {
        document: input.cnpj,
      },
      select: {
        id: true,
        requesterId: true,
        status: true,
        document: true,
        documentType: true,
      },
    });

    let lock: any = null;

    if (existingLock) {
      if (
        existingLock.requesterId === input.requesterId &&
        existingLock.status === "PROCESSING"
      ) {
        return {
          pending: true,
          status: "PROCESSING",
          consultLockId: existingLock.id,
          document: existingLock.document,
          documentType: existingLock.documentType,
          message:
            "Esta consulta já está em processamento. Acompanhando o status da análise.",
        };
      }

      if (
        existingLock.requesterId === input.requesterId &&
        existingLock.status === "FAILED"
      ) {
        lock = await prisma.oragoConsultLock.update({
          where: { id: existingLock.id },
          data: {
            status: "PROCESSING",
            errorMessage: null,
            oragoAnalysisId: null,
            rentValue: input.rentValue,
            condominiumValue: input.condominiumValue,
            feesValue: input.feesValue,
          },
        });
      } else {
        throw new AppError(
          409,
          "Este CPF/CNPJ já possui uma consulta em processamento ou já foi consultado.",
          "DOCUMENT_CONSULT_IN_PROGRESS",
        );
      }
    } else {
      lock = await this.createConsultLock({
        requesterId: input.requesterId,
        document: input.cnpj,
        documentType: "CNPJ",
        rentValue: input.rentValue,
        condominiumValue: input.condominiumValue,
        feesValue: input.feesValue,
      });
    }

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
        { attempts: 1, delayMs: 0 },
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

    const canSeeConsultStatus =
      params.role === "ADMIN" ||
      params.role === "ACCOUNT_EXECUTIVE" ||
      lock.requesterId === params.requesterId;

    if (!canSeeConsultStatus) {
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

    const extraAnalysisIds: string[] = [];
    if (lock.additionalOragoAnalysisIds) {
      try {
        const parsed = JSON.parse(lock.additionalOragoAnalysisIds);
        if (Array.isArray(parsed)) {
          extraAnalysisIds.push(...parsed);
        }
      } catch {}
    } else if (lock.secondOragoAnalysisId) {
      extraAnalysisIds.push(lock.secondOragoAnalysisId);
    }

    if (extraAnalysisIds.length > 0) {
      const allAnalysisIds = [lock.oragoAnalysisId, ...extraAnalysisIds];

      let extraDocs: string[] = [];
      if (lock.additionalDocuments) {
        try {
          const parsed = JSON.parse(lock.additionalDocuments);
          if (Array.isArray(parsed)) {
            extraDocs.push(...parsed);
          }
        } catch {}
      } else if (lock.secondDocument) {
        extraDocs.push(lock.secondDocument);
      }
      const allDocs = [lock.document, ...extraDocs];

      let collects: any[] = [];

      try {
        collects = await Promise.all(
          allAnalysisIds.map((id) =>
            tryCollectOragoWithRetry(id, {
              attempts: 1,
              delayMs: 0,
            }),
          ),
        );
      } catch (error) {
        const message = getErrorMessage(error);

        if (
          error instanceof AppError &&
          error.code === "ORAGO_COLLECT_RETURNED_ERROR"
        ) {
          await prisma.oragoConsultLock.update({
            where: { id: lock.id },
            data: { status: "FAILED", errorMessage: message },
          });

          return { status: "FAILED", message };
        }

        console.warn("[ORAGO_POLL_JOINT_TEMPORARY_ERROR]", {
          analysisIds: allAnalysisIds,
          message,
        });

        return {
          status: "PROCESSING",
          consultLockId: lock.id,
          message: "As análises ainda estão em processamento na Órago.",
        };
      }

      if (collects.some((c) => !c)) {
        return {
          status: "PROCESSING",
          consultLockId: lock.id,
          message: "As análises ainda estão em processamento na Órago.",
        };
      }

      try {
        const result = await this.finalizeJointOragoConsult({
          lockId: lock.id,
          requesterId: lock.requesterId,
          document: lock.document,
          rentValue: Number(lock.rentValue),
          condominiumValue: Number(lock.condominiumValue),
          feesValue: Number(lock.feesValue),
          tenants: allDocs.map((doc, idx) => ({
            order: idx + 1,
            document: doc,
            oragoAnalysisId: allAnalysisIds[idx],
            collectResponse: collects[idx],
          })),
        });

        return {
          status: "COMPLETED",
          ...result,
        };
      } catch (error) {
        const message = getErrorMessage(error);

        await prisma.oragoConsultLock.update({
          where: { id: lock.id },
          data: { status: "FAILED", errorMessage: message },
        });

        return {
          status: "FAILED",
          message,
        };
      }
    }

    let collectResponse: any = null;

    try {
      collectResponse = await tryCollectOragoWithRetry(lock.oragoAnalysisId, {
        attempts: 1,
        delayMs: 0,
      });
    } catch (error) {
      const message = getErrorMessage(error);

      if (
        error instanceof AppError &&
        error.code === "ORAGO_COLLECT_RETURNED_ERROR"
      ) {
        await prisma.oragoConsultLock.update({
          where: {
            id: lock.id,
          },
          data: {
            status: "FAILED",
            errorMessage: message,
          },
        });

        return {
          status: "FAILED",
          message,
        };
      }

      console.warn("[ORAGO_POLL_TEMPORARY_ERROR]", {
        analysisId: lock.oragoAnalysisId,
        message,
      });

      return {
        status: "PROCESSING",
        consultLockId: lock.id,
        message: "A análise ainda está em processamento na Órago.",
      };
    }

    if (!collectResponse) {
      return {
        status: "PROCESSING",
        consultLockId: lock.id,
        message: "A análise ainda está em processamento na Órago.",
      };
    }

    try {
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
    } catch (error) {
      const message = getErrorMessage(error);

      await prisma.oragoConsultLock.update({
        where: {
          id: lock.id,
        },
        data: {
          status: "FAILED",
          errorMessage: message,
        },
      });

      return {
        status: "FAILED",
        message,
      };
    }
  }

  async updateRentalValues(params: {
    applicationId: string;
    adminId: string;
    data: {
      rentValue: number;
      condominiumValue: number;
      feesValue: number;
    };
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.status !== "WAITING_ADMIN_CONTRACT") {
      throw new AppError(
        400,
        "Os valores só podem ser editados antes da geração do contrato.",
        "RENTAL_VALUES_EDIT_NOT_ALLOWED",
      );
    }

    const requestedExpense =
      params.data.rentValue +
      params.data.condominiumValue +
      params.data.feesValue;

    const updatedApplication = await prisma.rentalApplication.update({
      where: {
        id: params.applicationId,
      },
      data: {
        rentValue: params.data.rentValue,
        condominiumValue: params.data.condominiumValue,
        feesValue: params.data.feesValue,
        requestedExpense,
      },
    });

    await prisma.contract.updateMany({
      where: {
        applicationId: params.applicationId,
        status: "FAILED",
      },
      data: {
        status: "PENDING",
        errorMessage: null,
      },
    });

    return updatedApplication;
  }

  async fillContractData(params: {
    applicationId: string;
    requesterId: string;
    data: {
      tenants: Array<{
        name: string;
        document: string;
        email: string;
        phone: string;
      }>;
      propertyZipCode: string;
      propertyStreet: string;
      propertyNumber: string;
      propertyComplement?: string;
      propertyNeighborhood: string;
      propertyCity: string;
      propertyState: string;
      adhesionFee: number;
      rentValue?: number;
      condominiumValue?: number;
      feesValue?: number;
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

    const canFillContractData =
      application.status === "WAITING_CONTRACT_DATA" ||
      application.status === "WAITING_ADMIN_CONTRACT" ||
      (application.status === "WAITING_REAL_ESTATE_RETURN" &&
        (application.previousStatus === "WAITING_CONTRACT_DATA" ||
          application.previousStatus === "WAITING_ADMIN_CONTRACT"));

    if (!canFillContractData) {
      throw new AppError(
        400,
        "Essa consulta ainda não está liberada para preenchimento dos dados do contrato",
      );
    }

    const [mainTenant] = params.data.tenants;

    const mainTenantDocument = mainTenant.document.replace(/\D/g, "");

    if (mainTenantDocument !== application.document) {
      throw new AppError(
        400,
        "O documento do primeiro locatário deve ser o mesmo utilizado na consulta.",
        "MAIN_TENANT_DOCUMENT_MISMATCH",
      );
    }

    const rentValue =
      params.data.rentValue !== undefined && params.data.rentValue !== null
        ? params.data.rentValue
        : Number(application.rentValue);

    const condominiumValue =
      params.data.condominiumValue !== undefined && params.data.condominiumValue !== null
        ? params.data.condominiumValue
        : Number(application.condominiumValue);

    const feesValue =
      params.data.feesValue !== undefined && params.data.feesValue !== null
        ? params.data.feesValue
        : Number(application.feesValue ?? 0);

    const requestedExpense = rentValue + condominiumValue + feesValue;

    const updatedApplication = await prisma.$transaction(async (tx) => {
      const updated = await tx.rentalApplication.update({
        where: { id: params.applicationId },
        data: {
          tenantName: mainTenant.name,
          tenantDocument: mainTenantDocument,
          tenantEmail: mainTenant.email,
          tenantPhone: mainTenant.phone.replace(/\D/g, ""),

          propertyZipCode: params.data.propertyZipCode.replace(/\D/g, ""),
          propertyStreet: params.data.propertyStreet,
          propertyNumber: params.data.propertyNumber,
          propertyComplement: params.data.propertyComplement,
          propertyNeighborhood: params.data.propertyNeighborhood,
          propertyCity: params.data.propertyCity,
          propertyState: params.data.propertyState,
          adhesionFee: params.data.adhesionFee,

          rentValue,
          condominiumValue,
          feesValue,
          requestedExpense,

          status: "WAITING_ADMIN_CONTRACT",
          previousStatus: null,
        },
      });

      const existingTenants = await tx.rentalApplicationTenant.findMany({
        where: {
          applicationId: params.applicationId,
        },
      });

      await tx.rentalApplicationTenant.deleteMany({
        where: {
          applicationId: params.applicationId,
        },
      });

      await tx.rentalApplicationTenant.createMany({
        data: params.data.tenants.map((tenant, index) => {
          const docDigits = tenant.document.replace(/\D/g, "");
          const match = existingTenants.find(
            (et) =>
              et.document.replace(/\D/g, "") === docDigits ||
              et.order === index + 1,
          );
          return {
            applicationId: params.applicationId,
            order: index + 1,
            name: tenant.name,
            document: docDigits,
            email: tenant.email,
            phone: tenant.phone.replace(/\D/g, ""),
            oragoAnalysisId: match?.oragoAnalysisId ?? null,
            oragoData: match?.oragoData ?? null,
            presumedIncome: match?.presumedIncome ?? null,
            incomePercentage: match?.incomePercentage ?? null,
            isPrimaryIncome: match?.isPrimaryIncome ?? false,
            recommendation: match?.recommendation ?? null,
            decisionReasons: match?.decisionReasons ?? null,
          };
        }),
      });

      await tx.contract.upsert({
        where: {
          applicationId: params.applicationId,
        },
        create: {
          applicationId: params.applicationId,
          status: "PENDING",
          templateName: "default-rental-application-contract.docx",
        },
        update: {
          status: "PENDING",
        },
      });

      return updated;
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

    const blockedStatuses = ["CONTRACT_GENERATED", "CANCELLED"];

    if (blockedStatuses.includes(application.status)) {
      throw new AppError(
        400,
        "Não é possível alterar manualmente uma consulta finalizada ou cancelada.",
        "ADMIN_DECISION_NOT_ALLOWED",
      );
    }

    const hasContractData =
      Boolean(application.tenantName) &&
      Boolean(application.tenantDocument) &&
      Boolean(application.propertyZipCode) &&
      Boolean(application.propertyStreet) &&
      Boolean(application.propertyNumber) &&
      Boolean(application.propertyNeighborhood) &&
      Boolean(application.propertyCity) &&
      Boolean(application.propertyState);

    const nextStatus =
      params.decision === "APPROVED"
        ? hasContractData
          ? "WAITING_ADMIN_CONTRACT"
          : "WAITING_CONTRACT_DATA"
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

  async deleteApplication(params: {
    applicationId: string;
    requesterId: string;
    role: string;
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
      include: {
        contract: true,
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (
      params.role !== "ADMIN" &&
      application.requesterId !== params.requesterId
    ) {
      throw new AppError(403, "Acesso negado");
    }

    await prisma.$transaction(async (tx) => {
      await tx.oragoConsultLock.deleteMany({
        where: {
          document: application.document,
        },
      });

      await tx.rentalApplication.delete({
        where: {
          id: application.id,
        },
      });
    });

    return {
      deleted: true,
      id: application.id,
    };
  }

  async reopenForEditing(params: { applicationId: string }) {
    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
      include: {
        contract: true,
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.contract?.signatureStatus === "SIGNED") {
      throw new AppError(
        400,
        "Contrato já assinado e não pode ter dados reabertos.",
      );
    }

    if (
      application.contract?.clicksignEnvelopeId &&
      application.contract?.clicksignDocumentId
    ) {
      try {
        await clicksignClient.cancelDocument({
          envelopeId: application.contract.clicksignEnvelopeId,
          documentId: application.contract.clicksignDocumentId,
        });
      } catch (error) {
        console.error("[CLICKSIGN_REOPEN_CANCEL_ERROR]", error);
      }
    }

    await prisma.$transaction(async (tx) => {
      if (application.contract) {
        await tx.contractSigner.deleteMany({
          where: {
            contractId: application.contract.id,
          },
        });

        await tx.contract.update({
          where: {
            id: application.contract.id,
          },
          data: {
            status: "PENDING",
            clicksignEnvelopeId: null,
            clicksignDocumentId: null,
            signatureStatus: "NOT_SENT",
            signatureError: null,
            sentToSignatureAt: null,
            signedAt: null,
          },
        });
      }

      await tx.rentalApplication.update({
        where: {
          id: application.id,
        },
        data: {
          status: "WAITING_CONTRACT_DATA",
        },
      });
    });

    return prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
      include: {
        contract: true,
        tenants: true,
      },
    });
  }

  async getUnreadCount() {
    const count = await prisma.rentalApplication.count({
      where: {
        adminViewedAt: null,
        createdAt: {
          gte: UNREAD_NOTIFICATIONS_CUTOFF_DATE,
        },
      },
    });

    return { count };
  }

  async declineApplication(params: {
    applicationId: string;
    adminId: string;
    reason?: string;
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
      include: {
        contract: true,
      },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.contract?.signatureStatus === "SIGNED") {
      throw new AppError(
        400,
        "Não é possível declinar uma consulta cujo contrato já foi assinado.",
        "CONTRACT_ALREADY_SIGNED",
      );
    }

    if (
      application.contract?.clicksignEnvelopeId &&
      application.contract?.clicksignDocumentId &&
      ["SENT", "PARTIALLY_SIGNED", "ENVELOPE_CREATED", "ACTION_REQUIRED"].includes(
        application.contract.signatureStatus ?? "",
      )
    ) {
      try {
        await clicksignClient.cancelDocument({
          envelopeId: application.contract.clicksignEnvelopeId,
          documentId: application.contract.clicksignDocumentId,
        });
      } catch (error) {
        console.error("[CLICKSIGN_CANCEL_DOCUMENT_ON_DECLINE_ERROR]", error);
      }
    }

    await prisma.$transaction(async (tx) => {
      if (application.contract) {
        await tx.contract.update({
          where: { id: application.contract.id },
          data: {
            signatureStatus: "REFUSED",
          },
        });
      }

      await tx.rentalApplication.update({
        where: { id: application.id },
        data: {
          status: "CONTRACT_DECLINED",
          adminDecisionReason: params.reason
            ? `Declinado pelo locatário: ${params.reason}`
            : "Declinado pelo locatário",
          adminDecisionById: params.adminId,
          adminDecisionAt: new Date(),
        },
      });
    });

    return prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
      include: {
        contract: true,
        tenants: true,
      },
    });
  }

  async markAsViewed(params: { applicationId: string }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
      select: { id: true, adminViewedAt: true },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.adminViewedAt) {
      return { id: application.id, adminViewedAt: application.adminViewedAt };
    }

    const updated = await prisma.rentalApplication.update({
      where: { id: params.applicationId },
      data: {
        adminViewedAt: new Date(),
      },
      select: {
        id: true,
        adminViewedAt: true,
      },
    });

    return updated;
  }
}

