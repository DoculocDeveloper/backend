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
  let sellerAllowedRealEstateIds: string[] = [];
  if (request.user!.role === "SELLER") {
    const associations = await prisma.realEstateSeller.findMany({
      where: { sellerId: request.user!.id },
      select: { realEstateId: true },
    });
    sellerAllowedRealEstateIds = associations.map((a) => a.realEstateId);
    if (
      request.user!.realEstateId &&
      !sellerAllowedRealEstateIds.includes(request.user!.realEstateId)
    ) {
      sellerAllowedRealEstateIds.push(request.user!.realEstateId);
    }
  }

  const isOwner =
    contract.application.requesterId === request.user!.id ||
    (request.user!.role === "SELLER" &&
      sellerAllowedRealEstateIds.includes(contract.application.requesterId));

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
    let sellerAllowedRealEstateIds: string[] = [];
    if (request.user!.role === "SELLER") {
      const associations = await prisma.realEstateSeller.findMany({
        where: { sellerId: request.user!.id },
        select: { realEstateId: true },
      });
      sellerAllowedRealEstateIds = associations.map((a) => a.realEstateId);
      if (
        request.user!.realEstateId &&
        !sellerAllowedRealEstateIds.includes(request.user!.realEstateId)
      ) {
        sellerAllowedRealEstateIds.push(request.user!.realEstateId);
      }
    }

    const isOwner =
      contract.application.requesterId === request.user!.id ||
      (request.user!.role === "SELLER" &&
        sellerAllowedRealEstateIds.includes(contract.application.requesterId));

    if (!isAdmin && !isOwner) {
      throw new AppError(403, "Acesso negado");
    }

function extractSignedUrlFromAny(obj: any, depth = 0): string | null {
  if (!obj || depth > 8) return null;

  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.startsWith("http://") || s.startsWith("https://")) {
      if (
        !s.includes("/relationships/") &&
        !s.endsWith("/documents") &&
        !s.endsWith("/signers")
      ) {
        return s;
      }
    }
    return null;
  }

  if (typeof obj !== "object") return null;

  // 1. Prioridade alta: propriedades com 'signed' ou 'download' no nome
  if (typeof obj.signed_file_url === "string" && obj.signed_file_url.startsWith("http")) {
    return obj.signed_file_url;
  }
  if (
    typeof obj.downloads?.signed_file_url === "string" &&
    obj.downloads.signed_file_url.startsWith("http")
  ) {
    return obj.downloads.signed_file_url;
  }
  if (
    typeof obj.downloads?.original_file_url === "string" &&
    obj.downloads.original_file_url.startsWith("http")
  ) {
    return obj.downloads.original_file_url;
  }
  if (typeof obj.original_file_url === "string" && obj.original_file_url.startsWith("http")) {
    return obj.original_file_url;
  }
  if (
    typeof obj.downloads?.zipped_file_url === "string" &&
    obj.downloads.zipped_file_url.startsWith("http")
  ) {
    return obj.downloads.zipped_file_url;
  }

  // 2. Chaves específicas da Clicksign (v1 e v3)
  if (obj.document) {
    const found = extractSignedUrlFromAny(obj.document, depth + 1);
    if (found) return found;
  }
  if (obj.downloads) {
    const found = extractSignedUrlFromAny(obj.downloads, depth + 1);
    if (found) return found;
  }
  if (obj.attributes) {
    const found = extractSignedUrlFromAny(obj.attributes, depth + 1);
    if (found) return found;
  }
  if (obj.data) {
    const found = extractSignedUrlFromAny(obj.data, depth + 1);
    if (found) return found;
  }
  if (Array.isArray(obj.included)) {
    for (const item of obj.included) {
      const found = extractSignedUrlFromAny(item, depth + 1);
      if (found) return found;
    }
  }

  // 3. Varre todos os valores do objeto/array recursivamente
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractSignedUrlFromAny(item, depth + 1);
      if (found) return found;
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "self" || key === "links" || key === "related") continue;
      const found = extractSignedUrlFromAny(value, depth + 1);
      if (found) return found;
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

        const status = docResponse?.data?.attributes?.status;
        const dlKeys = docResponse?.data?.attributes?.downloads
          ? Object.keys(docResponse.data.attributes.downloads)
          : [];

        signedUrl = extractSignedUrlFromAny(docResponse);

        debugAttempts.push({
          step: "getDocument_v3",
          status: `st=${status || "?"},dl=[${dlKeys.join(",")}]`,
          keys: docResponse?.data?.attributes
            ? Object.keys(docResponse.data.attributes)
            : docResponse
              ? Object.keys(docResponse)
              : [],
        });
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

        signedUrl = extractSignedUrlFromAny(envDocs);

        if (!documentId && envDocs?.data?.[0]?.id) {
          documentId = envDocs.data[0].id;
          await prisma.contract.update({
            where: { id: contract.id },
            data: { clicksignDocumentId: documentId },
          });
        }

        const firstDocAttrs = envDocs?.data?.[0]?.attributes;
        const dlKeys = firstDocAttrs?.downloads ? Object.keys(firstDocAttrs.downloads) : [];

        debugAttempts.push({
          step: "getEnvelopeDocuments_v3",
          status: `docs=${envDocs?.data?.length || 0},dl=[${dlKeys.join(",")}]`,
          keys: firstDocAttrs ? Object.keys(firstDocAttrs) : [],
        });
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

        signedUrl = extractSignedUrlFromAny(envWithDocs);

        debugAttempts.push({
          step: "getEnvelope_include_docs",
          status: `envSt=${envWithDocs?.data?.attributes?.status || "?"},inc=${envWithDocs?.included?.length || 0}`,
          keys: envWithDocs && typeof envWithDocs === "object" ? Object.keys(envWithDocs) : [],
        });
      } catch (error: any) {
        debugAttempts.push({ step: "getEnvelope_include_docs", error: error?.message || String(error) });
      }
    }

    // 4. Se tiver documentId, tenta endpoint v1 (legado com token)
    if (!signedUrl && documentId) {
      try {
        const docV1: any = await clicksignClient.getDocumentV1(documentId);
        const docObj = docV1?.document ?? docV1;
        const status = docObj?.status;
        const dlKeys = docObj?.downloads ? Object.keys(docObj.downloads) : [];

        signedUrl = extractSignedUrlFromAny(docV1);

        debugAttempts.push({
          step: "getDocument_v1",
          status: `st=${status || "?"},dl=[${dlKeys.join(",")}]`,
          keys: docObj ? Object.keys(docObj) : [],
        });
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
            `${a.step}: ${a.error ? `erro(${a.error})` : a.status || "sem_url"}`,
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