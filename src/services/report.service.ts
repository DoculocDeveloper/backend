import { Prisma } from "@prisma/client";
import { UserRole } from "../domain/roles.js";
import { prisma } from "../lib/prisma.js";
import { GetReportsSummaryQuery } from "../schemas/report.schemas.js";

function parseDateBoundary(dateStr?: string, isEnd = false): Date | undefined {
  if (!dateStr) return undefined;
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(
      `${trimmed}T${isEnd ? "23:59:59.999" : "00:00:00.000"}Z`
    );
  }
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface RealEstateReportItem {
  id: string;
  name: string;
  email: string;
  document: string | null;
  totalApplications: number;
  generatedContracts: {
    count: number;
    totalValue: number;
  };
  declinedContracts: {
    count: number;
    totalValue: number;
  };
  averageTicket: number;
  conversionRate: number;
}

export interface ReportsSummaryResult {
  period: {
    startDate?: string;
    endDate?: string;
  };
  totals: {
    totalApplications: number;
    generatedContracts: {
      count: number;
      totalValue: number;
    };
    declinedContracts: {
      count: number;
      totalValue: number;
    };
    averageTicket: number;
    conversionRate: number;
  };
  realEstates: RealEstateReportItem[];
}

export class ReportService {
  async getSummary(query: GetReportsSummaryQuery): Promise<ReportsSummaryResult> {
    const { startDate, endDate, requesterId } = query;

    const gte = parseDateBoundary(startDate, false);
    const lte = parseDateBoundary(endDate, true);

    const createdAtFilter: Prisma.DateTimeFilter = {};
    if (gte) createdAtFilter.gte = gte;
    if (lte) createdAtFilter.lte = lte;

    const where: Prisma.RentalApplicationWhereInput = {
      ...(requesterId ? { requesterId } : {}),
      ...(Object.keys(createdAtFilter).length > 0
        ? { createdAt: createdAtFilter }
        : {}),
    };

    // 1. Obter aplicações no período
    const applications = await prisma.rentalApplication.findMany({
      where,
      select: {
        id: true,
        status: true,
        rentValue: true,
        requestedExpense: true,
        requesterId: true,
        createdAt: true,
        requester: {
          select: {
            id: true,
            name: true,
            email: true,
            realEstateProfile: {
              select: {
                name: true,
                responsibleName: true,
                cnpj: true,
                document: true,
              },
            },
          },
        },
      },
    });

    // 2. Obter imobiliárias correspondentes (ou todas caso não passe requesterId)
    const realEstatesUsers = await prisma.user.findMany({
      where: {
        role: UserRole.REAL_ESTATE,
        ...(requesterId ? { id: requesterId } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        realEstateProfile: {
          select: {
            name: true,
            responsibleName: true,
            cnpj: true,
            document: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Mapa para agregar dados por imobiliária
    const realEstateMap = new Map<
      string,
      {
        id: string;
        name: string;
        email: string;
        document: string | null;
        totalApplications: number;
        generatedCount: number;
        generatedValue: number;
        declinedCount: number;
        declinedValue: number;
      }
    >();

    // Inicializa com as imobiliárias cadastradas
    for (const re of realEstatesUsers) {
      realEstateMap.set(re.id, {
        id: re.id,
        name: re.realEstateProfile?.name || re.name,
        email: re.email,
        document:
          re.realEstateProfile?.document || re.realEstateProfile?.cnpj || null,
        totalApplications: 0,
        generatedCount: 0,
        generatedValue: 0,
        declinedCount: 0,
        declinedValue: 0,
      });
    }

    let totalApplications = 0;
    let totalGeneratedCount = 0;
    let totalGeneratedValue = 0;
    let totalDeclinedCount = 0;
    let totalDeclinedValue = 0;

    for (const app of applications) {
      totalApplications += 1;
      const val = Number(app.rentValue ?? app.requestedExpense ?? 0);

      let item = realEstateMap.get(app.requesterId);
      if (!item) {
        item = {
          id: app.requesterId,
          name:
            app.requester?.realEstateProfile?.name ||
            app.requester?.name ||
            "Imobiliária",
          email: app.requester?.email || "",
          document:
            app.requester?.realEstateProfile?.document ||
            app.requester?.realEstateProfile?.cnpj ||
            null,
          totalApplications: 0,
          generatedCount: 0,
          generatedValue: 0,
          declinedCount: 0,
          declinedValue: 0,
        };
        realEstateMap.set(app.requesterId, item);
      }

      item.totalApplications += 1;

      if (app.status === "CONTRACT_GENERATED") {
        totalGeneratedCount += 1;
        totalGeneratedValue += val;
        item.generatedCount += 1;
        item.generatedValue += val;
      } else if (app.status === "CONTRACT_DECLINED") {
        totalDeclinedCount += 1;
        totalDeclinedValue += val;
        item.declinedCount += 1;
        item.declinedValue += val;
      }
    }

    const realEstatesResult: RealEstateReportItem[] = Array.from(
      realEstateMap.values()
    )
      .map((item) => {
        const averageTicket =
          item.generatedCount > 0
            ? Number((item.generatedValue / item.generatedCount).toFixed(2))
            : 0;
        const conversionRate =
          item.totalApplications > 0
            ? Number(
                ((item.generatedCount / item.totalApplications) * 100).toFixed(
                  1
                )
              )
            : 0;

        return {
          id: item.id,
          name: item.name,
          email: item.email,
          document: item.document,
          totalApplications: item.totalApplications,
          generatedContracts: {
            count: item.generatedCount,
            totalValue: Number(item.generatedValue.toFixed(2)),
          },
          declinedContracts: {
            count: item.declinedCount,
            totalValue: Number(item.declinedValue.toFixed(2)),
          },
          averageTicket,
          conversionRate,
        };
      })
      // Se não filtrou por uma específica, mostrar primeiro as que tiveram mais movimentação
      .sort((a, b) => {
        if (b.totalApplications !== a.totalApplications) {
          return b.totalApplications - a.totalApplications;
        }
        return b.generatedContracts.totalValue - a.generatedContracts.totalValue;
      });

    const averageTicket =
      totalGeneratedCount > 0
        ? Number((totalGeneratedValue / totalGeneratedCount).toFixed(2))
        : 0;
    const conversionRate =
      totalApplications > 0
        ? Number(((totalGeneratedCount / totalApplications) * 100).toFixed(1))
        : 0;

    return {
      period: {
        startDate,
        endDate,
      },
      totals: {
        totalApplications,
        generatedContracts: {
          count: totalGeneratedCount,
          totalValue: Number(totalGeneratedValue.toFixed(2)),
        },
        declinedContracts: {
          count: totalDeclinedCount,
          totalValue: Number(totalDeclinedValue.toFixed(2)),
        },
        averageTicket,
        conversionRate,
      },
      realEstates: realEstatesResult,
    };
  }
}

