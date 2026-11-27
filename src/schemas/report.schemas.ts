import { z } from "zod";

export const getReportsSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  requesterId: z.string().uuid().optional(),
});

export type GetReportsSummaryQuery = z.infer<
  typeof getReportsSummaryQuerySchema
>;

export const reportApplicationCategorySchema = z.enum([
  "ALL",
  "REJECTED",
  "ONLY_CONSULTED",
  "DECLINED",
  "GENERATED",
  "SIGNED",
]);

export const getReportApplicationsQuerySchema = z.object({
  category: reportApplicationCategorySchema.default("ALL"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  requesterId: z.string().uuid().optional(),
});

export type ReportApplicationCategory = z.infer<
  typeof reportApplicationCategorySchema
>;

export type GetReportApplicationsQuery = z.infer<
  typeof getReportApplicationsQuerySchema
>;

