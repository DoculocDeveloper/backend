// Errors
import { AppError } from "../middlewares/error-handler.js";

// Libs
import { prisma } from "../lib/prisma.js";

export class CreditService {
  async ensureCanConsult(userId: string, requiredCredits: number = 1) {
    const wallet = await prisma.userCreditWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError(403, "Carteira de créditos não encontrada");
    }

    if (wallet.isVip) {
      return wallet;
    }

    if (wallet.availableCredits < requiredCredits) {
      throw new AppError(
        402,
        requiredCredits > 1
          ? `Você precisa de pelo menos ${requiredCredits} consultas disponíveis para realizar esta análise conjunta.`
          : "Usuário sem consultas disponíveis",
      );
    }

    return wallet;
  }

  async consumeConsultCreditStandalone(userId: string, applicationId?: string) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.userCreditWallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        throw new AppError(403, "Carteira de créditos não encontrada");
      }

      if (wallet.isVip) {
        await tx.creditLedger.create({
          data: {
            userId,
            type: "CONSULT_USED",
            amount: 0,
            balanceAfter: wallet.availableCredits,
            reason: applicationId
              ? `Consulta realizada como VIP. Application: ${applicationId}`
              : "Consulta realizada como VIP",
          },
        });

        return wallet;
      }

      if (wallet.availableCredits <= 0) {
        throw new AppError(402, "Usuário sem consultas disponíveis");
      }

      const updatedWallet = await tx.userCreditWallet.update({
        where: { userId },
        data: {
          availableCredits: {
            decrement: 1,
          },
        },
      });

      await tx.creditLedger.create({
        data: {
          userId,
          type: "CONSULT_USED",
          amount: -1,
          balanceAfter: updatedWallet.availableCredits,
          reason: applicationId
            ? `Crédito consumido na consulta. Application: ${applicationId}`
            : "Crédito consumido na consulta",
        },
      });

      return updatedWallet;
    });
  }

  async setCredits(params: {
    userId: string;
    actorId: string;
    credits: number;
    reason?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.userCreditWallet.upsert({
        where: { userId: params.userId },
        create: {
          userId: params.userId,
          availableCredits: params.credits,
          isVip: false,
        },
        update: {
          availableCredits: params.credits,
        },
      });

      await tx.creditLedger.create({
        data: {
          userId: params.userId,
          actorId: params.actorId,
          type: "ADMIN_SET",
          amount: params.credits,
          balanceAfter: wallet.availableCredits,
          reason: params.reason ?? "Créditos definidos pelo admin",
        },
      });

      return wallet;
    });
  }

  async setVip(params: {
    userId: string;
    actorId: string;
    isVip: boolean;
    reason?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.userCreditWallet.upsert({
        where: { userId: params.userId },
        create: {
          userId: params.userId,
          availableCredits: 3,
          isVip: params.isVip,
        },
        update: {
          isVip: params.isVip,
        },
      });

      await tx.creditLedger.create({
        data: {
          userId: params.userId,
          actorId: params.actorId,
          type: params.isVip ? "VIP_ENABLED" : "VIP_DISABLED",
          amount: 0,
          balanceAfter: wallet.availableCredits,
          reason:
            params.reason ??
            (params.isVip ? "VIP ativado pelo admin" : "VIP desativado pelo admin"),
        },
      });

      return wallet;
    });
  }
}