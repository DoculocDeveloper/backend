import { UserRole } from "../domain/roles.js";
import { cnpjSchema } from "./document.schemas.js";
import z from "zod";

const optionalCnpjSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  cnpjSchema.optional(),
);

export const realEstateProfileSchema = z.object({
  name: z.string().min(3),
  cnpj: optionalCnpjSchema,
  phone: z.string().min(8),
  responsibleName: z.string().min(3),

  zipCode: z.string().optional(),
  street: z.string().optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const registerSchema = z.object({
  name: z.string().min(3).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  role: z
    .enum([UserRole.ADMIN, UserRole.REAL_ESTATE])
    .default(UserRole.REAL_ESTATE),
  realEstateProfile: realEstateProfileSchema.optional(),
}).superRefine((data, context) => {
  if (data.role === UserRole.ADMIN && !data.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Nome é obrigatório para administradores",
    });
  }

  if (data.role === UserRole.ADMIN && data.realEstateProfile) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["realEstateProfile"],
      message: "Dados de imobiliária só devem ser enviados para usuários REAL_ESTATE",
    });
  }

  if (data.role === UserRole.REAL_ESTATE && !data.realEstateProfile) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["realEstateProfile"],
      message: "Dados da imobiliária são obrigatórios para usuários REAL_ESTATE",
    });
  }
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(8),
  passwordConfirmation: z.string().min(8),
}).refine((data) => data.password === data.passwordConfirmation, {
  path: ["passwordConfirmation"],
  message: "As senhas não conferem",
});

export const createAccountExecutiveSchema = z.object({
  name: z.string().min(3, "Informe o nome do usuário."),
  email: z.string().email("Informe um e-mail válido."),
  password: z.string().min(8, "A senha deve ter pelo menos 8 caracteres."),
});