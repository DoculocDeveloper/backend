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
  rejectedApplications: {
    count: number;
    totalValue: number;
    rate: number;
  };
  generatedContracts: {
    count: number;
    totalValue: number;
  };
  signedContracts: {
    count: number;
    totalValue: number;
  };
  declinedContracts: {
    count: number;
    totalValue: number;
  };
  averageTicket: number;
  conversionRate: number; // gerados / consultas (%)
  signedConversionRate: number; // assinados / gerados (%)
  signedSharePercentage: number; // % do total de contratos assinados da Doculoc
  signedValueSharePercentage: number; // % do valor total de contratos assinados da Doculoc
}

export interface ReportsSummaryResult {
  period: {
    startDate?: string;
    endDate?: string;
  };
  doculocGlobal: {
    totalApplications: number;
    totalRejectedApplications: {
      count: number;
      totalValue: number;
      rate: number;
    };
    totalGeneratedContracts: {
      count: number;
      totalValue: number;
    };
    totalSignedContracts: {
      count: number;
      totalValue: number;
    };
  };
  totals: {
    totalApplications: number;
    rejectedApplications: {
      count: number;
      totalValue: number;
      rate: number;
    };
    generatedContracts: {
      count: number;
      totalValue: number;
    };
    signedContracts: {
      count: number;
      totalValue: number;
    };
    declinedContracts: {
      count: number;
      totalValue: number;
    };
    averageTicket: number;
    conversionRate: number;
    signedConversionRate: number;
    signedSharePercentage: number;
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

    const periodWhere: Prisma.RentalApplicationWhereInput =
      Object.keys(createdAtFilter).length > 0
        ? { createdAt: createdAtFilter }
        : {};

    // 1. Obter todas as aplicações da Doculoc no período (para métricas globais e cálculo de share)
    const allApplications = await prisma.rentalApplication.findMany({
      where: periodWhere,
      select: {
        id: true,
        status: true,
        adminDecision: true,
        automaticDecision: true,
        rentValue: true,
        requestedExpense: true,
        requesterId: true,
        createdAt: true,
        contract: {
          select: {
            id: true,
            status: true,
            signatureStatus: true,
            signedAt: true,
          },
        },
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

    // 2. Obter todas as imobiliárias
    const realEstatesUsers = await prisma.user.findMany({
      where: {
        role: UserRole.REAL_ESTATE,
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

    // Mapa para agregação por imobiliária
    const realEstateMap = new Map<
      string,
      {
        id: string;
        name: string;
        email: string;
        document: string | null;
        totalApplications: number;
        rejectedCount: number;
        rejectedValue: number;
        generatedCount: number;
        generatedValue: number;
        signedCount: number;
        signedValue: number;
        declinedCount: number;
        declinedValue: number;
      }
    >();

    for (const re of realEstatesUsers) {
      realEstateMap.set(re.id, {
        id: re.id,
        name: re.realEstateProfile?.name || re.name,
        email: re.email,
        document:
          re.realEstateProfile?.document || re.realEstateProfile?.cnpj || null,
        totalApplications: 0,
        rejectedCount: 0,
        rejectedValue: 0,
        generatedCount: 0,
        generatedValue: 0,
        signedCount: 0,
        signedValue: 0,
        declinedCount: 0,
        declinedValue: 0,
      });
    }

    let globalTotalApplications = 0;
    let globalRejectedCount = 0;
    let globalRejectedValue = 0;
    let globalGeneratedCount = 0;
    let globalGeneratedValue = 0;
    let globalSignedCount = 0;
    let globalSignedValue = 0;
    let globalDeclinedCount = 0;
    let globalDeclinedValue = 0;

    for (const app of allApplications) {
      globalTotalApplications += 1;
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
          rejectedCount: 0,
          rejectedValue: 0,
          generatedCount: 0,
          generatedValue: 0,
          signedCount: 0,
          signedValue: 0,
          declinedCount: 0,
          declinedValue: 0,
        };
        realEstateMap.set(app.requesterId, item);
      }

      item.totalApplications += 1;

      const isRejected =
        app.status === "ADMIN_REJECTED" ||
        app.status === "REJECTED" ||
        app.adminDecision === "REJECTED";
      if (isRejected) {
        globalRejectedCount += 1;
        globalRejectedValue += val;
        item.rejectedCount += 1;
        item.rejectedValue += val;
      }

      const isGenerated = app.status === "CONTRACT_GENERATED";
      const isSigned =
        isGenerated &&
        (app.contract?.signatureStatus === "SIGNED" ||
          app.contract?.signedAt !== null && app.contract?.signedAt !== undefined);

      if (isGenerated) {
        globalGeneratedCount += 1;
        globalGeneratedValue += val;
        item.generatedCount += 1;
        item.generatedValue += val;
      }

      if (isSigned) {
        globalSignedCount += 1;
        globalSignedValue += val;
        item.signedCount += 1;
        item.signedValue += val;
      }

      if (app.status === "CONTRACT_DECLINED") {
        globalDeclinedCount += 1;
        globalDeclinedValue += val;
        item.declinedCount += 1;
        item.declinedValue += val;
      }
    }

    // Gerar lista de imobiliárias com percentual de representatividade do total Doculoc
    const allRealEstatesResult: RealEstateReportItem[] = Array.from(
      realEstateMap.values()
    ).map((item) => {
      const averageTicket =
        item.generatedCount > 0
          ? Number((item.generatedValue / item.generatedCount).toFixed(2))
          : 0;

      const conversionRate =
        item.totalApplications > 0
          ? Number(((item.generatedCount / item.totalApplications) * 100).toFixed(1))
          : 0;

      const signedConversionRate =
        item.generatedCount > 0
          ? Number(((item.signedCount / item.generatedCount) * 100).toFixed(1))
          : 0;

      const rejectedRate =
        item.totalApplications > 0
          ? Number(((item.rejectedCount / item.totalApplications) * 100).toFixed(1))
          : 0;

      // Representatividade sobre o total de contratos assinados da Doculoc (ex: 10 de 500 = 2.0%)
      const signedSharePercentage =
        globalSignedCount > 0
          ? Number(((item.signedCount / globalSignedCount) * 100).toFixed(1))
          : 0;

      const signedValueSharePercentage =
        globalSignedValue > 0
          ? Number(((item.signedValue / globalSignedValue) * 100).toFixed(1))
          : 0;

      return {
        id: item.id,
        name: item.name,
        email: item.email,
        document: item.document,
        totalApplications: item.totalApplications,
        rejectedApplications: {
          count: item.rejectedCount,
          totalValue: Number(item.rejectedValue.toFixed(2)),
          rate: rejectedRate,
        },
        generatedContracts: {
          count: item.generatedCount,
          totalValue: Number(item.generatedValue.toFixed(2)),
        },
        signedContracts: {
          count: item.signedCount,
          totalValue: Number(item.signedValue.toFixed(2)),
        },
        declinedContracts: {
          count: item.declinedCount,
          totalValue: Number(item.declinedValue.toFixed(2)),
        },
        averageTicket,
        conversionRate,
        signedConversionRate,
        signedSharePercentage,
        signedValueSharePercentage,
      };
    });

    // Se filtrou por uma imobiliária específica, filtra a lista para ela
    const filteredRealEstates = requesterId
      ? allRealEstatesResult.filter((re) => re.id === requesterId)
      : allRealEstatesResult.sort((a, b) => {
          // Ordena primeiro por contratos assinados (receita fechada), depois por total de consultas
          if (b.signedContracts.count !== a.signedContracts.count) {
            return b.signedContracts.count - a.signedContracts.count;
          }
          if (b.generatedContracts.count !== a.generatedContracts.count) {
            return b.generatedContracts.count - a.generatedContracts.count;
          }
          return b.totalApplications - a.totalApplications;
        });

    // Totais calculados para a resposta (se selecionou uma imobiliária, totais dela; senão, global)
    let totals;
    if (requesterId && filteredRealEstates.length > 0) {
      const selected = filteredRealEstates[0];
      totals = {
        totalApplications: selected.totalApplications,
        rejectedApplications: selected.rejectedApplications,
        generatedContracts: selected.generatedContracts,
        signedContracts: selected.signedContracts,
        declinedContracts: selected.declinedContracts,
        averageTicket: selected.averageTicket,
        conversionRate: selected.conversionRate,
        signedConversionRate: selected.signedConversionRate,
        signedSharePercentage: selected.signedSharePercentage,
      };
    } else {
      const globalAverageTicket =
        globalGeneratedCount > 0
          ? Number((globalGeneratedValue / globalGeneratedCount).toFixed(2))
          : 0;
      const globalConversionRate =
        globalTotalApplications > 0
          ? Number(((globalGeneratedCount / globalTotalApplications) * 100).toFixed(1))
          : 0;
      const globalSignedConversionRate =
        globalGeneratedCount > 0
          ? Number(((globalSignedCount / globalGeneratedCount) * 100).toFixed(1))
          : 0;
      const globalRejectedRate =
        globalTotalApplications > 0
          ? Number(((globalRejectedCount / globalTotalApplications) * 100).toFixed(1))
          : 0;

      totals = {
        totalApplications: globalTotalApplications,
        rejectedApplications: {
          count: globalRejectedCount,
          totalValue: Number(globalRejectedValue.toFixed(2)),
          rate: globalRejectedRate,
        },
        generatedContracts: {
          count: globalGeneratedCount,
          totalValue: Number(globalGeneratedValue.toFixed(2)),
        },
        signedContracts: {
          count: globalSignedCount,
          totalValue: Number(globalSignedValue.toFixed(2)),
        },
        declinedContracts: {
          count: globalDeclinedCount,
          totalValue: Number(globalDeclinedValue.toFixed(2)),
        },
        averageTicket: globalAverageTicket,
        conversionRate: globalConversionRate,
        signedConversionRate: globalSignedConversionRate,
        signedSharePercentage: 100,
      };
    }

    const globalRejectedRate =
      globalTotalApplications > 0
        ? Number(((globalRejectedCount / globalTotalApplications) * 100).toFixed(1))
        : 0;

    return {
      period: {
        startDate,
        endDate,
      },
      doculocGlobal: {
        totalApplications: globalTotalApplications,
        totalRejectedApplications: {
          count: globalRejectedCount,
          totalValue: Number(globalRejectedValue.toFixed(2)),
          rate: globalRejectedRate,
        },
        totalGeneratedContracts: {
          count: globalGeneratedCount,
          totalValue: Number(globalGeneratedValue.toFixed(2)),
        },
        totalSignedContracts: {
          count: globalSignedCount,
          totalValue: Number(globalSignedValue.toFixed(2)),
        },
      },
      totals,
      realEstates: filteredRealEstates,
    };
  }
}
