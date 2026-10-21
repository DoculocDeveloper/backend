// Libs
import { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { z } from "zod";

// Services
import { ContractService } from "../services/contract.service.js";
import { StorageService } from "../services/storage.service.js";
import { ClicksignClient } from "../services/clicksign-client.js";

// Errors
import { AppError } from "../middlewares/error-handler.js";

const contractService = new ContractService();
const storageService = new StorageService();
const clicksignClient = new ClicksignClient();

const applicationParamsSchema = z.object({
  applicationId: z.string().uuid(),
});

const contractParamsSchema = z.object({
  id: z.string().uuid(),
});

export class ContractController {
  async generate(request: Request, response: Response) {
    const params = applicationParamsSchema.parse(request.params);

    const contract = await contractService.generateContract({
      applicationId: params.applicationId,
      adminId: request.user!.id,
    });

    return response.status(201).json({ contract });
  }

  async download(request: Request, response: Response) {
  const params = contractParamsSchema.parse(request.params);

  const contract = await prisma.contract.findUnique({
    where: {
      id: params.id,
    },
    include: {
      application: true,
    },
  });

  if (!contract) {
    throw new AppError(404, "Contrato não encontrado");
  }

  const isAdmin = request.user!.role === "ADMIN";
  let sellerRealEstateId = request.user!.realEstateId;
  if (request.user!.role === "SELLER" && !sellerRealEstateId) {
    const sellerUser = await prisma.user.findUnique({
      where: { id: request.user!.id },
      select: { realEstateId: true },
    });
    sellerRealEstateId = sellerUser?.realEstateId;
  }

  const isOwner =
    contract.application.requesterId === request.user!.id ||
    (request.user!.role === "SELLER" &&
      Boolean(sellerRealEstateId) &&
      contract.application.requesterId === sellerRealEstateId);

  if (!isAdmin && !isOwner) {
    throw new AppError(403, "Acesso negado");
  }

  const fileName = contract.fileName ?? "contrato-doculoc.docx";

  if (contract.storageDriver === "r2" || contract.storageDriver === "s3") {
    if (!contract.storageKey) {
      throw new AppError(404, "Arquivo do contrato não encontrado");
    }

    const file = await storageService.getObjectStream({
      key: contract.storageKey,
    });

    response.setHeader(
      "Content-Type",
      file.contentType ??
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );

    if (file.contentLength) {
      response.setHeader("Content-Length", String(file.contentLength));
    }

    return file.stream.pipe(response);
  }

  if (!contract.filePath) {
    throw new AppError(404, "Arquivo do contrato não encontrado");
  }

  return response.download(contract.filePath, fileName);
}

  async downloadSigned(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await prisma.contract.findUnique({
      where: {
        id: params.id,
      },
      include: {
        application: true,
      },
    });

    if (!contract) {
      throw new AppError(404, "Contrato não encontrado");
    }

    const isAdmin = request.user!.role === "ADMIN";
    let sellerRealEstateId = request.user!.realEstateId;
    if (request.user!.role === "SELLER" && !sellerRealEstateId) {
      const sellerUser = await prisma.user.findUnique({
        where: { id: request.user!.id },
        select: { realEstateId: true },
      });
      sellerRealEstateId = sellerUser?.realEstateId;
    }

    const isOwner =
      contract.application.requesterId === request.user!.id ||
      (request.user!.role === "SELLER" &&
        Boolean(sellerRealEstateId) &&
        contract.application.requesterId === sellerRealEstateId);

    if (!isAdmin && !isOwner) {
      throw new AppError(403, "Acesso negado");
    }

    if (contract.clicksignEnvelopeId && contract.clicksignDocumentId) {
      try {
        const docResponse = await clicksignClient.getDocument({
          envelopeId: contract.clicksignEnvelopeId,
          documentId: contract.clicksignDocumentId,
        });

        const signedUrl =
          docResponse?.data?.attributes?.downloads?.signed_file_url ??
          docResponse?.data?.attributes?.downloads?.original_file_url;

        if (signedUrl) {
          return response.json({ url: signedUrl });
        }
      } catch (error) {
        console.error("[CLICKSIGN_GET_SIGNED_DOCUMENT_ERROR]", error);
      }
    }

    return this.download(request, response);
  }
}