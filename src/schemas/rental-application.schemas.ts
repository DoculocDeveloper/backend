// Libs
import { z } from "zod";

import { cpfSchema, cnpjSchema } from "./document.schemas.js";

export const rentalApplicationStatusSchema = z.enum([
  "CONSULTED",
  "WAITING_CONTRACT_DATA",
  "WAITING_ADMIN_CONTRACT",
  "CONTRACT_GENERATED",
  "REJECTED",
  "CONTESTED",
  "ADMIN_REJECTED",
  "CANCELLED",
]);

export const createRentalApplicationByCpfSchema = z.object({
  cpf: cpfSchema,
  email: z.string().email().optional(),
  phone: z.string().optional(),
  selfie: z.string().optional(),

  rentValue: z.coerce.number().positive("O valor do aluguel não pode ser negativo ou zero"),
  condominiumValue: z.coerce.number().min(0, "O valor do condomínio não pode ser negativo"),
  feesValue: z.coerce.number().min(0, "O valor do IPTU não pode ser negativo"),
});

export const createRentalApplicationByCnpjSchema = z.object({
  cnpj: cnpjSchema,

  rentValue: z.coerce.number().positive("O valor do aluguel não pode ser negativo ou zero"),
  condominiumValue: z.coerce.number().min(0, "O valor do condomínio não pode ser negativo"),
  feesValue: z.coerce.number().min(0, "O valor do IPTU não pode ser negativo"),
});

export const rentalApplicationParamsSchema = z.object({
  id: z.string().uuid("O ID da solicitação de aluguel deve ser um UUID válido"),
});

export const updateRentalValuesSchema = z.object({
  rentValue: z.coerce.number().positive("O valor do aluguel deve ser maior que zero"),
  condominiumValue: z.coerce.number().min(0, "O valor do condomínio não pode ser negativo"),
  feesValue: z.coerce.number().min(0, "O valor do IPTU não pode ser negativo"),
});

export const fillContractDataSchema = z.object({
  tenantName: z.string().min(3, "O nome do inquilino deve conter pelo menos 3 caracteres"),
  tenantDocument: z
  .string()
  .regex(
    /^\d{11}$|^\d{14}$/,
    "O documento do locatário deve ser CPF com 11 dígitos ou CNPJ com 14 dígitos",
  ),
  tenantEmail: z.string().email("O email do inquilino deve ser um email válido"),
  tenantPhone: z.string().min(8, "O telefone do inquilino deve conter pelo menos 8 caracteres"),

  propertyZipCode: z.string().min(8, "O CEP da propriedade deve conter pelo menos 8 caracteres"),
  propertyStreet: z.string().min(3, "A rua da propriedade deve conter pelo menos 3 caracteres"),
  propertyNumber: z.string().min(1, "O número da propriedade deve conter pelo menos 1 caractere"),
  propertyComplement: z.string().optional(),
  propertyNeighborhood: z.string().min(2, "O bairro da propriedade deve conter pelo menos 2 caracteres"),
  propertyCity: z.string().min(2, "A cidade da propriedade deve conter pelo menos 2 caracteres"),
  propertyState: z.string().length(2, "O estado da propriedade deve conter exatamente 2 caracteres"),

  adhesionFee: z.coerce.number().min(0, "O valor da taxas de adesão não pode ser negativo")
});

export const contestRentalApplicationSchema = z.object({
  reason: z.string().min(10, "O motivo deve conter pelo menos 10 caracteres"),
});

export const adminDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().min(3, "O motivo deve conter pelo menos 3 caracteres").optional(),
});

export const listRentalApplicationsSchema = z.object({
  requesterId: z.string().uuid().optional(),
  status: rentalApplicationStatusSchema.optional(),
  document: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(25),
});