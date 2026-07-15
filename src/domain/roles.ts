export const UserRole = {
  ADMIN: "ADMIN",
  REAL_ESTATE: "REAL_ESTATE",
  ACCOUNT_EXECUTIVE: "ACCOUNT_EXECUTIVE",
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const DocumentType = {
  CPF: "CPF",
  CNPJ: "CNPJ",
} as const;

export const AutomaticDecisionStatus = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;

export const RecommendationStatus = {
  RECOMMENDED: "RECOMMENDED",
  NOT_RECOMMENDED: "NOT_RECOMMENDED",
  UNKNOWN: "UNKNOWN",
} as const;

export const RentalApplicationStatus = {
  CONSULTED: "CONSULTED",
  WAITING_CONTRACT_DATA: "WAITING_CONTRACT_DATA",
  WAITING_ADMIN_CONTRACT: "WAITING_ADMIN_CONTRACT",
  CONTRACT_GENERATED: "CONTRACT_GENERATED",
  REJECTED: "REJECTED",
  CONTESTED: "CONTESTED",
  ADMIN_REJECTED: "ADMIN_REJECTED",
  CANCELLED: "CANCELLED",
} as const;