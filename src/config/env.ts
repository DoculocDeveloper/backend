import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3333),
  HOST: z.string().default("localhost"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24, "JWT_SECRET deve ter ao menos 24 caracteres"),
  ORAGO_BASE_URL: z.string().url(),
  ORAGO_API_TOKEN: z.string().min(1),

  CONTRACT_TEMPLATE_PATH: z
    .string()
    .default("src/templates/default-rental-application-contract.docx"),

  CONTRACT_OUTPUT_DIR: z.string().default("storage/contracts"),

  LIBREOFFICE_PATH: z.string().default("soffice"),

  STORAGE_DRIVER: z.enum(["local", "r2", "s3"]).default("local"),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  CLICKSIGN_BASE_URL: z.string().url().optional(),
  CLICKSIGN_ACCESS_TOKEN: z.string().optional(),

  CLICKSIGN_DEADLINE_DAYS: z.coerce.number().int().positive().default(30),
  CLICKSIGN_WEBHOOK_SECRET: z.string().optional(),

  CLICKSIGN_DOCULOC_SIGNER_NAME: z.string().optional(),
  CLICKSIGN_DOCULOC_SIGNER_EMAIL: z.string().email().optional(),
  CLICKSIGN_DOCULOC_SIGNER_PHONE: z.string().optional(),
  CLICKSIGN_DOCULOC_SIGNER_DOCUMENT: z.string().optional(),

  CORS_ORIGIN: z.string().optional(),

  APP_URL: z.string().url().default("http://localhost:5173"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  PASSWORD_RESET_TOKEN_EXPIRES_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(180),
});

const parsedEnv = envSchema.parse(process.env);

if (parsedEnv.STORAGE_DRIVER !== "local") {
  const requiredKeys = [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;

  for (const key of requiredKeys) {
    if (!parsedEnv[key]) {
      throw new Error(
        `${key} é obrigatório quando STORAGE_DRIVER=${parsedEnv.STORAGE_DRIVER}`,
      );
    }
  }
}

export const env = parsedEnv;
