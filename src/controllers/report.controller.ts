import { Request, Response } from "express";
import { getReportsSummaryQuerySchema } from "../schemas/report.schemas.js";
import { ReportService } from "../services/report.service.js";

export class ReportController {
  private reportService = new ReportService();

  getSummary = async (request: Request, response: Response) => {
    const validatedQuery = getReportsSummaryQuerySchema.parse(request.query);

    const result = await this.reportService.getSummary(validatedQuery);

    return response.json(result);
  };
}
