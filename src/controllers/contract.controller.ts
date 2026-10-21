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

    if (!contract.clicksignEnvelopeId) {
      throw new AppError(
        400,
        "Este contrato ainda não possui registro de assinatura na Clicksign.",
      );
    }

    let signedUrl: string | null = null;
    let documentId = contract.clicksignDocumentId;

    // 1. Tenta buscar o documento pelo documentId já salvo
    if (documentId) {
      try {
        const docResponse = await clicksignClient.getDocument({
          envelopeId: contract.clicksignEnvelopeId,
          documentId,
        });

        signedUrl =
          docResponse?.data?.attributes?.downloads?.signed_file_url ??
          docResponse?.data?.attributes?.downloads?.original_file_url ??
          (docResponse?.data?.attributes as any)?.signed_file_url ??
          null;
      } catch (error) {
        console.warn("[CLICKSIGN_GET_DOCUMENT_FALLBACK]", error);
      }
    }

    // 2. Se não encontrou a URL ou não tínhamos documentId, consulta a lista de documentos do envelope
    if (!signedUrl) {
      try {
        const envDocs = await clicksignClient.getEnvelopeDocuments(
          contract.clicksignEnvelopeId,
        );

        const docs = envDocs?.data ?? [];
        if (docs.length > 0) {
          const matchedDoc = docs[0];

          if (!documentId && matchedDoc?.id) {
            documentId = matchedDoc.id;
            await prisma.contract.update({
              where: { id: contract.id },
              data: { clicksignDocumentId: matchedDoc.id },
            });
          }

          signedUrl =
            matchedDoc?.attributes?.downloads?.signed_file_url ??
            matchedDoc?.attributes?.downloads?.original_file_url ??
            (matchedDoc?.attributes as any)?.signed_file_url ??
            null;
        }
      } catch (error) {
        console.error("[CLICKSIGN_GET_ENVELOPE_DOCS_ERROR]", error);
      }
    }

    if (!signedUrl) {
      throw new AppError(
        400,
        "O arquivo assinado ainda não está disponível para download na Clicksign. Aguarde alguns instantes e tente novamente.",
      );
    }

    // Tenta fazer o stream do arquivo assinado (PDF) direto para o cliente
    try {
      const fileResponse = await fetch(signedUrl);
      if (fileResponse.ok) {
        const safeDocNumber = contract.application.document.replace(/\D/g, "");
        const downloadFileName = `contrato-assinado-${safeDocNumber || "doculoc"}.pdf`;

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${encodeURIComponent(downloadFileName)}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`,
        );

        const arrayBuffer = await fileResponse.arrayBuffer();
        return response.send(Buffer.from(arrayBuffer));
      }
    } catch (streamError) {
      console.warn("[CLICKSIGN_STREAM_ERROR_RETURNING_JSON]", streamError);
    }

    return response.json({ url: signedUrl });
  }
}