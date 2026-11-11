// Libs
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

function mapRecommendationStatus(status: string) {
  if (status === "recommended") return "RECOMMENDED";
  if (status === "not_recommended") return "NOT_RECOMMENDED";
  return "UNKNOWN";
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
    secondDocument: string;
    oragoAnalysisId: string;
    secondOragoAnalysisId: string;
    collectResponse: any;
    secondCollectResponse: any;
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

    const requestedExpense =
      params.rentValue + params.condominiumValue + params.feesValue;

    // 1. Locatário 1
    const decision1 = evaluateTenant({
      documentType: "CPF",
      oragoData: params.collectResponse.data,
      input: {
        rentValue: params.rentValue,
        condominiumValue: params.condominiumValue,
        feesValue: params.feesValue,
      },
    });
    const tenantName1 =
      extractApplicantName("CPF", params.collectResponse.data) || "Locatário 1";
    const incomeRange1 = parseCurrencyRange(
      params.collectResponse.data?.financial?.presumed_income,
    );
    const income1 = incomeRange1.max ?? incomeRange1.min ?? 0;
    const rec1 = mapRecommendationStatus(decision1.recommendation);

    // 2. Locatário 2
    const decision2 = evaluateTenant({
      documentType: "CPF",
      oragoData: params.secondCollectResponse.data,
      input: {
        rentValue: params.rentValue,
        condominiumValue: params.condominiumValue,
        feesValue: params.feesValue,
      },
    });
    const tenantName2 =
      extractApplicantName("CPF", params.secondCollectResponse.data) ||
      "Locatário 2";
    const incomeRange2 = parseCurrencyRange(
      params.secondCollectResponse.data?.financial?.presumed_income,
    );
    const income2 = incomeRange2.max ?? incomeRange2.min ?? 0;
    const rec2 = mapRecommendationStatus(decision2.recommendation);

    // 3. Composição de Renda
    const totalPresumedIncome = income1 + income2;
    const isPrimary1 = income1 >= income2;
    const isPrimary2 = !isPrimary1;
    const percent1 =
      totalPresumedIncome > 0 ? (income1 / totalPresumedIncome) * 100 : 50;
    const percent2 =
      totalPresumedIncome > 0 ? (income2 / totalPresumedIncome) * 100 : 50;

    const combinedIncomeMin =
      (incomeRange1.min ?? 0) + (incomeRange2.min ?? 0);
    const combinedIncomeMax =
      (incomeRange1.max ?? 0) + (incomeRange2.max ?? 0);
    const combinedHousingExpenseMin =
      combinedIncomeMin > 0 ? combinedIncomeMin * 0.3 : null;
    const combinedHousingExpenseMax =
      combinedIncomeMax > 0 ? combinedIncomeMax * 0.3 : null;

    // 4. Matriz de Decisão:
    // Regra do Usuário: "se 1 recomendar e outro tiver apontamentos, ficar como em analise."
    const isRec1 = decision1.recommendation === "recommended";
    const isRec2 = decision2.recommendation === "recommended";
    const isNotRec1 = decision1.recommendation === "not_recommended";
    const isNotRec2 = decision2.recommendation === "not_recommended";

    let automaticDecision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW" =
      "MANUAL_REVIEW";
    let recommendation: "RECOMMENDED" | "NOT_RECOMMENDED" | "UNKNOWN" =
      "UNKNOWN";
    let workflowStatus: "WAITING_CONTRACT_DATA" | "REJECTED" | "CONSULTED" =
      "CONSULTED";
    let reasons: string[] = [];

    if (isRec1 && isRec2) {
      if (
        combinedHousingExpenseMax &&
        requestedExpense <= combinedHousingExpenseMax
      ) {
        automaticDecision = "APPROVED";
        recommendation = "RECOMMENDED";
        workflowStatus = "WAITING_CONTRACT_DATA";
        reasons = [
          "Ambos os locatários foram recomendados pela Órago e a renda combinada cobre a despesa locatícia.",
        ];
      } else {
        automaticDecision = "MANUAL_REVIEW";
        recommendation = "UNKNOWN";
        workflowStatus = "CONSULTED";
        reasons = [
          `Ambos os locatários foram recomendados, mas a despesa de R$ ${requestedExpense.toFixed(
            2,
          )} excede o limite somado de moradia de R$ ${(
            combinedHousingExpenseMax ?? 0
          ).toFixed(2)}.`,
        ];
      }
    } else if (isNotRec1 && isNotRec2) {
      automaticDecision = "REJECTED";
      recommendation = "NOT_RECOMMENDED";
      workflowStatus = "REJECTED";
      reasons = [
        "Ambos os locatários retornaram como não recomendados na análise Órago.",
      ];
    } else {
      // 1 recomendou e o outro teve apontamentos / atenção / desconhecido -> Em Análise Manual
      automaticDecision = "MANUAL_REVIEW";
      recommendation = "UNKNOWN";
      workflowStatus = "CONSULTED";
      const pointedTenant = !isRec1 ? tenantName1 : tenantName2;
      reasons = [
        `Composição com apontamento: ${pointedTenant} possui apontamentos na Órago. Enviado para análise manual Doculoc.`,
      ];
    }

    const application = await this.createApplicationAndConsumeCredit({
      requesterId: params.requesterId,
      creditsToConsume: 2,
      data: {
        documentType: "CPF",
        document: params.document,
        requesterId: params.requesterId,

        tenantName: tenantName1,
        tenantDocument: params.document,
        tenantEmail: params.email,
        tenantPhone: params.phone,

        oragoAnalysisId: params.oragoAnalysisId,
        oragoRawResponse: JSON.stringify(params.collectResponse),
        oragoData: JSON.stringify(params.collectResponse.data),

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
          tenant1: {
            name: tenantName1,
            document: params.document,
            income: income1,
            incomePercentage: percent1,
            isPrimaryIncome: isPrimary1,
            recommendation: rec1,
            decisionReasons: decision1.reasons,
          },
          tenant2: {
            name: tenantName2,
            document: params.secondDocument,
            income: income2,
            incomePercentage: percent2,
            isPrimaryIncome: isPrimary2,
            recommendation: rec2,
            decisionReasons: decision2.reasons,
          },
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
          create: [
            {
              order: 1,
              name: tenantName1,
              document: params.document,
              email: params.email ?? "",
              phone: params.phone ?? "",
              oragoAnalysisId: params.oragoAnalysisId,
              oragoData: JSON.stringify(params.collectResponse.data),
              presumedIncome: income1,
              incomePercentage: percent1,
              isPrimaryIncome: isPrimary1,
              recommendation: rec1,
              decisionReasons: JSON.stringify(decision1.reasons),
            },
            {
              order: 2,
              name: tenantName2,
              document: params.secondDocument,
              email: "",
              phone: "",
              oragoAnalysisId: params.secondOragoAnalysisId,
              oragoData: JSON.stringify(params.secondCollectResponse.data),
              presumedIncome: income2,
              incomePercentage: percent2,
              isPrimaryIncome: isPrimary2,
              recommendation: rec2,
              decisionReasons: JSON.stringify(decision2.reasons),
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
    const isJoint = Boolean(input.secondCpf);

    await this.assertDocumentWasNotConsulted(input.cpf);
    if (input.secondCpf) {
      await this.assertDocumentWasNotConsulted(input.secondCpf);
    }

    const creditsNeeded = isJoint ? 2 : 1;
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
            secondDocument: input.secondCpf ?? null,
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
        secondDocument: input.secondCpf ?? null,
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
        // Fluxo com 2 CPFs (Composição de Renda)
        const [orago1, orago2] = await Promise.all([
          oragoClient.createPfAnalysis({
            cpf: input.cpf,
            email: input.email,
            phone: input.phone,
            selfie: input.selfie,
            products: oragoProducts,
          }),
          oragoClient.createPfAnalysis({
            cpf: input.secondCpf!,
            products: oragoProducts,
          }),
        ]);

        await prisma.oragoConsultLock.update({
          where: {
            id: lock.id,
          },
          data: {
            oragoAnalysisId: orago1.analysis_id,
            secondOragoAnalysisId: orago2.analysis_id,
          },
        });

        const [collect1, collect2] = await Promise.all([
          tryCollectOragoWithRetry(orago1.analysis_id, {
            attempts: 1,
            delayMs: 0,
          }),
          tryCollectOragoWithRetry(orago2.analysis_id, {
            attempts: 1,
            delayMs: 0,
          }),
        ]);

        if (!collect1 || !collect2) {
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
          secondDocument: input.secondCpf!,
          oragoAnalysisId: orago1.analysis_id,
          secondOragoAnalysisId: orago2.analysis_id,
          collectResponse: collect1,
          secondCollectResponse: collect2,
          rentValue: input.rentValue,
          condominiumValue: input.condominiumValue,
          feesValue: input.feesValue,
          email: input.email,
          phone: input.phone,
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

    if (lock.secondOragoAnalysisId) {
      let collect1: any = null;
      let collect2: any = null;

      try {
        [collect1, collect2] = await Promise.all([
          tryCollectOragoWithRetry(lock.oragoAnalysisId, {
            attempts: 1,
            delayMs: 0,
          }),
          tryCollectOragoWithRetry(lock.secondOragoAnalysisId, {
            attempts: 1,
            delayMs: 0,
          }),
        ]);
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
          analysisId1: lock.oragoAnalysisId,
          analysisId2: lock.secondOragoAnalysisId,
          message,
        });

        return {
          status: "PROCESSING",
          consultLockId: lock.id,
          message: "As análises ainda estão em processamento na Órago.",
        };
      }

      if (!collect1 || !collect2) {
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
          secondDocument: lock.secondDocument ?? "",
          oragoAnalysisId: lock.oragoAnalysisId,
          secondOragoAnalysisId: lock.secondOragoAnalysisId,
          collectResponse: collect1,
          secondCollectResponse: collect2,
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
      application.status === "WAITING_ADMIN_CONTRACT";

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

