import {
  TenantDecisionInput,
  TenantDecisionResult,
} from "../schemas/consults.schemas.js";
import { calculatePjHousingExpense } from "./calculate-pj-housing-expense.js";
import { extractOragoDecision } from "./extract-orago-decision.js";
import { parseNumber } from "./parse-number.js";
import { parsePercentage } from "./parse-percentage.js";

function isCompanyRecent(foundationDateStr?: string | null): boolean {
  if (!foundationDateStr || typeof foundationDateStr !== "string") return false;

  let date: Date | null = null;
  if (foundationDateStr.includes("/")) {
    const parts = foundationDateStr.split("/");
    if (parts.length === 3) {
      date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
  } else {
    date = new Date(foundationDateStr);
  }

  if (!date || isNaN(date.getTime())) return false;

  const now = new Date();
  const diffInDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
  return diffInDays < 365;
}

export function evaluatePjTenant(
  oragoData: any,
  input: TenantDecisionInput,
): TenantDecisionResult {
  const company = oragoData?.company;
  const financial = oragoData?.financial;
  const judicial = oragoData?.judicial;

  const requestedExpense =
    input.rentValue + input.condominiumValue + input.feesValue;

  const oragoDecision = extractOragoDecision(oragoData);

  // Score de locação específico (Órago)
  const rentalScore =
    parseNumber(oragoData?.rental_score) ??
    parseNumber(oragoData?.rentalScore) ??
    parseNumber(oragoData?.rental_risk?.score) ??
    parseNumber(oragoData?.rental_risk?.rentalScore) ??
    parseNumber(oragoData?.resume?.rental_score) ??
    parseNumber(oragoData?.resume?.score) ??
    parseNumber(financial?.rental_score) ??
    parseNumber(financial?.rentalScore);

  // Score financeiro geral (Birô)
  const financialScore =
    parseNumber(financial?.credit_score) ??
    parseNumber(financial?.riskScore) ??
    parseNumber(financial?.score) ??
    parseNumber(company?.score);

  // Score efetivo considerado na análise
  const creditScore =
    rentalScore !== null && financialScore !== null
      ? Math.min(rentalScore, financialScore)
      : (rentalScore ?? financialScore);

  // Probabilidade de inadimplência / Risco de não pagar
  const defaultProbability =
    parsePercentage(financial?.default_prob) ??
    parsePercentage(financial?.default_probability) ??
    parsePercentage(financial?.defaultProbability) ??
    parsePercentage(oragoData?.rental_risk?.default_probability) ??
    parsePercentage(oragoData?.resume?.default_probability) ??
    parsePercentage(financial?.risk_default);

  const financialRiskLevel = parseNumber(financial?.riskLevel);
  const companyRiskLevel = parseNumber(company?.riskLevel);

  // Risco locatício (ex: Faixa E, Faixa D, Risco Muito Alto)
  const rentalRiskClassification = String(
    oragoData?.rental_risk?.classification ??
      oragoData?.rental_risk?.level ??
      oragoData?.resume?.risk_level ??
      "",
  ).toUpperCase();

  const isHighRentalRisk =
    rentalRiskClassification.includes("E") ||
    rentalRiskClassification.includes("D") ||
    rentalRiskClassification.includes("MUITO ALTO") ||
    rentalRiskClassification.includes("ALTO");

  // Tempo de atividade da empresa
  const foundationDate =
    company?.foundationDate ??
    company?.founded_at ??
    company?.openingDate ??
    company?.open_date;

  const resumeTextUpper = (oragoDecision.resumeText ?? "").toUpperCase();

  const isRecentCompany =
    isCompanyRecent(foundationDate) ||
    resumeTextUpper.includes("RECEM-CONSTITUIDA") ||
    resumeTextUpper.includes("RECÉM-CONSTITUÍDA") ||
    resumeTextUpper.includes("MENOS DE 1 ANO") ||
    resumeTextUpper.includes("SEM OPERACAO CONSOLIDADA") ||
    resumeTextUpper.includes("SEM OPERAÇÃO CONSOLIDADA");

  const housingExpense = calculatePjHousingExpense({
    presumedRevenueAmount: financial?.presumedRevenueAmount,
    incomeRange: financial?.incomeRange,
    riskLevel: financialRiskLevel ?? companyRiskLevel,
    creditScore,
    defaultProbability,
  });

  const reviewReasons: string[] = [];
  const rejectionReasons: string[] = [];

  // 1. Decisão oficial da Órago
  if (oragoDecision.status === "not_recommended") {
    reviewReasons.push(
      "A análise oficial da Órago retornou com apontamentos restritivos.",
    );
  } else if (oragoDecision.status === "unknown") {
    reviewReasons.push(
      "Não foi possível identificar com segurança a recomendação oficial da Órago.",
    );
  }

  // 2. Score de crédito baixo (< 400)
  if (creditScore !== null && creditScore < 400) {
    reviewReasons.push(
      `Score de crédito da empresa em faixa de risco (${creditScore}/1000).`,
    );
  }

  // 3. Probabilidade de inadimplência alta (> 25%)
  if (defaultProbability !== null && defaultProbability > 25) {
    reviewReasons.push(
      `Probabilidade de inadimplência elevada (${defaultProbability.toFixed(1)}%).`,
    );
  }

  // 4. Faixa de risco locatício muito alto / alto
  if (isHighRentalRisk) {
    reviewReasons.push(
      `Classificação de risco locatício desfavorável (${rentalRiskClassification || "Risco elevado"}).`,
    );
  }

  // 5. Empresa recém-aberta (menos de 1 ano)
  if (isRecentCompany) {
    reviewReasons.push(
      "Empresa recém-constituída (menos de 1 ano de atividade / sem operação consolidada).",
    );
  }

  // 6. Restrições cadastrais, dívidas ou protestos
  if (
    Array.isArray(financial?.negative) &&
    financial.negative.length > 0
  ) {
    reviewReasons.push("Empresa possui registro de negativações ativas.");
  }

  if (
    financial?.has_debts === true ||
    (Array.isArray(financial?.debts) && financial.debts.length > 0)
  ) {
    reviewReasons.push("Empresa possui dívidas financeiras registradas.");
  }

  if (
    Array.isArray(financial?.protests) &&
    financial.protests.length > 0
  ) {
    reviewReasons.push(
      `Empresa possui protestos registrados (${financial.protests.length}).`,
    );
  }

  if (judicial?.hasAlertableLawSuits === true) {
    reviewReasons.push("Empresa possui processos judiciais alertáveis.");
  }

  // 7. Capacidade financeira calculada
  if (!housingExpense.max) {
    reviewReasons.push(
      "Não foi possível calcular a capacidade máxima de despesa com imóvel para a PJ.",
    );
  } else if (requestedExpense > housingExpense.max) {
    reviewReasons.push(
      `Despesa pretendida (R$ ${requestedExpense.toFixed(
        2,
      )}) está acima da capacidade máxima estimada (R$ ${housingExpense.max.toFixed(
        2,
      )}) para a empresa.`,
    );
  }

  // Se houver motivos de análise manual ou reprovação, direciona para manual_review
  if (reviewReasons.length > 0) {
    return {
      status: "manual_review",
      recommendation:
        oragoDecision.status === "not_recommended"
          ? "not_recommended"
          : "recommended",
      requestedExpense,
      housingExpense,
      reasons: reviewReasons,
      metadata: {
        decisionSource: "DOCULOC_RISK_POLICY",
        oragoDecision,
        doculocRuleApplied: true,
        requestedExpense,
        housingExpenseMax: housingExpense.max,
        rentalScore,
        financialScore,
        creditScore,
        defaultProbability,
        financialRiskLevel,
        companyRiskLevel,
        isRecentCompany,
        isHighRentalRisk,
      },
    };
  }

  return {
    status: "approved",
    recommendation: "recommended",
    requestedExpense,
    housingExpense,
    reasons: [
      "A Órago recomendou a análise, indicadores de risco favoráveis e despesa informada dentro da capacidade estimada.",
    ],
    metadata: {
      decisionSource: "ORAGO_AND_DOCULOC_HOUSING_RULE",
      oragoDecision,
      doculocRuleApplied: true,
      requestedExpense,
      housingExpenseMax: housingExpense.max,
      rentalScore,
      financialScore,
      creditScore,
      defaultProbability,
      financialRiskLevel,
      companyRiskLevel,
      isRecentCompany,
      isHighRentalRisk,
    },
  };
}