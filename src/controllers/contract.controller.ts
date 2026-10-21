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

function extractSignedUrlFromAny(obj: any): string | null {
  if (!obj) return null;

  if (typeof obj === "string") {
    const s = obj.trim();
    if (
      (s.startsWith("http://") || s.startsWith("https://")) &&
      (s.includes("signed") ||
        s.includes(".pdf") ||
        s.includes("clicksign-content") ||
        s.includes("s3.amazonaws.com") ||
        s.includes("downloads"))
    ) {
      return s;
    }
    return null;
  }

  if (typeof obj !== "object") return null;

  // Direct attributes
  if (obj.downloads?.signed_file_url) return obj.downloads.signed_file_url;
  if (obj.signed_file_url) return obj.signed_file_url;
  if (obj.downloads?.original_file_url) return obj.downloads.original_file_url;
  if (obj.original_file_url) return obj.original_file_url;

  if (obj.attributes) {
    const fromAttrs = extractSignedUrlFromAny(obj.attributes);
    if (fromAttrs) return fromAttrs;
  }

  if (obj.data) {
    const fromData = extractSignedUrlFromAny(obj.data);
    if (fromData) return fromData;
  }

  if (Array.isArray(obj.included)) {
    for (const item of obj.included) {
      const fromItem = extractSignedUrlFromAny(item);
      if (fromItem) return fromItem;
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const fromItem = extractSignedUrlFromAny(item);
      if (fromItem) return fromItem;
    }
  }

  return null;
}

    if (!contract.clicksignEnvelopeId) {
      throw new AppError(
        400,
        "Este contrato ainda não possui registro de assinatura na Clicksign.",
      );
    }

    let signedUrl: string | null = null;
    let documentId = contract.clicksignDocumentId;
    const debugAttempts: Array<{ step: string; status?: string; error?: string; keys?: string[] }> = [];

    // 1. Tenta buscar o documento pelo documentId já salvo (v3)
    if (documentId) {
      try {
        const docResponse: any = await clicksignClient.getDocument({
          envelopeId: contract.clicksignEnvelopeId,
          documentId,
        });

        debugAttempts.push({
          step: "getDocument_v3",
          status: "ok",
          keys: docResponse && typeof docResponse === "object" ? Object.keys(docResponse) : [],
        });

        signedUrl = extractSignedUrlFromAny(docResponse);
      } catch (error: any) {
        debugAttempts.push({ step: "getDocument_v3", error: error?.message || String(error) });
      }
    }

    // 2. Se não encontrou a URL ou não tínhamos documentId, consulta a lista de documentos do envelope (v3)
    if (!signedUrl) {
      try {
        const envDocs: any = await clicksignClient.getEnvelopeDocuments(
          contract.clicksignEnvelopeId,
        );

        debugAttempts.push({
          step: "getEnvelopeDocuments_v3",
          status: "ok",
          keys: envDocs && typeof envDocs === "object" ? Object.keys(envDocs) : [],
        });

        signedUrl = extractSignedUrlFromAny(envDocs);

        if (!documentId && envDocs?.data?.[0]?.id) {
          documentId = envDocs.data[0].id;
          await prisma.contract.update({
            where: { id: contract.id },
            data: { clicksignDocumentId: documentId },
          });
        }
      } catch (error: any) {
        debugAttempts.push({ step: "getEnvelopeDocuments_v3", error: error?.message || String(error) });
      }
    }

    // 3. Consulta envelope completo com includes de documents (v3)
    if (!signedUrl) {
      try {
        const envWithDocs: any = await clicksignClient.getEnvelope(
          contract.clicksignEnvelopeId,
          "documents",
        );

        debugAttempts.push({
          step: "getEnvelope_include_docs",
          status: "ok",
          keys: envWithDocs && typeof envWithDocs === "object" ? Object.keys(envWithDocs) : [],
        });

        signedUrl = extractSignedUrlFromAny(envWithDocs);
      } catch (error: any) {
        debugAttempts.push({ step: "getEnvelope_include_docs", error: error?.message || String(error) });
      }
    }

    // 4. Se tiver documentId, tenta endpoint v1 (legado com token)
    if (!signedUrl && documentId) {
      try {
        const docV1: any = await clicksignClient.getDocumentV1(documentId);
        debugAttempts.push({
          step: "getDocument_v1",
          status: "ok",
          keys: docV1 && typeof docV1 === "object" ? Object.keys(docV1) : [],
        });

        signedUrl = extractSignedUrlFromAny(docV1);
      } catch (error: any) {
        debugAttempts.push({ step: "getDocument_v1", error: error?.message || String(error) });
      }
    }

    // 5. Tenta extrair das payloads de webhooks já recebidas e salvas no banco
    if (!signedUrl) {
      try {
        const webhookEvents = await prisma.clicksignWebhookEvent.findMany({
          where: {
            OR: [
              { contractId: contract.id },
              { clicksignEnvelopeId: contract.clicksignEnvelopeId },
              ...(documentId ? [{ clicksignDocumentId: documentId }] : []),
            ],
          },
          orderBy: { createdAt: "desc" },
          take: 10,
        });

        for (const event of webhookEvents) {
          try {
            const parsed = JSON.parse(event.payload);
            const found = extractSignedUrlFromAny(parsed);
            if (found) {
              signedUrl = found;
              debugAttempts.push({ step: "webhook_payload_db", status: "found" });
              break;
            }
          } catch {
            // ignore parse error
          }
        }
      } catch (error: any) {
        debugAttempts.push({ step: "webhook_payload_db", error: error?.message || String(error) });
      }
    }

    if (!signedUrl) {
      console.error("[CLICKSIGN_DOWNLOAD_FAILED]", {
        contractId: contract.id,
        envelopeId: contract.clicksignEnvelopeId,
        documentId: contract.clicksignDocumentId,
        debugAttempts,
      });

      const failureSummary = debugAttempts
        .map(
          (a) =>
            `${a.step}: ${a.error ? `erro(${a.error})` : a.keys?.length ? `chaves[${a.keys.join(",")}]` : a.status || "sem_url"}`,
        )
        .join(" | ");

      throw new AppError(
        400,
        `O arquivo assinado ainda não está disponível na Clicksign. (${failureSummary})`,
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