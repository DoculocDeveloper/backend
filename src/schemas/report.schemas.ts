import { z } from "zod";

export const getReportsSummaryQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  requesterId: z.string().uuid().optional(),
});

export type GetReportsSummaryQuery = z.infer<
  typeof getReportsSummaryQuerySchema
>;

