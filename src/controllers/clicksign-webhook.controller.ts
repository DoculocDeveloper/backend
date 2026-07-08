import { Request, Response } from "express";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

function getEventName(body: any) {
  return (
    body?.event?.name ??
    body?.event ??
    body?.data?.attributes?.event_name ??
    body?.data?.attributes?.name ??
    body?.type ??
    null
  );
}

function getEnvelopeId(body: any) {
  return (
    body?.envelope?.id ??
    body?.envelope?.key ??
    body?.event?.data?.envelope?.id ??
    body?.event?.data?.envelope?.key ??
    body?.event?.data?.envelope_id ??
    body?.event?.data?.envelope_key ??
    body?.data?.relationships?.envelope?.data?.id ??
    body?.data?.attributes?.envelope_id ??
    body?.data?.attributes?.envelope?.id ??
    body?.data?.envelope_id ??
    null
  );
}

function getDocumentId(body: any) {
  return (
    body?.document?.id ??
    body?.document?.key ??
    body?.event?.data?.document?.id ??
    body?.event?.data?.document?.key ??
    body?.event?.data?.document_id ??
    body?.event?.data?.document_key ??
    body?.data?.relationships?.document?.data?.id ??
    body?.data?.attributes?.document_id ??
    body?.data?.attributes?.document?.id ??
    body?.data?.document_id ??
    null
  );
}

function getSignerId(body: any) {
  return (
    body?.signer?.id ??
    body?.signer?.key ??
    body?.event?.data?.signer?.id ??
    body?.event?.data?.signer?.key ??
    body?.event?.data?.signer_id ??
    body?.event?.data?.signer_key ??
    body?.data?.relationships?.signer?.data?.id ??
    body?.data?.relationships?.signers?.data?.id ??
    body?.data?.attributes?.signer_id ??
    body?.data?.attributes?.signer?.id ??
    body?.data?.signer_id ??
    null
  );
}

function getContractIdFromMetadata(body: any) {
  return (
    body?.document?.metadata?.contractId ??
    body?.document?.metadata?.contract_id ??
    body?.event?.data?.document?.metadata?.contractId ??
    body?.event?.data?.document?.metadata?.contract_id ??
    body?.data?.attributes?.metadata?.contractId ??
    body?.data?.attributes?.metadata?.contract_id ??
    null
  );
}

function normalizeEventName(eventName?: string | null) {
  return String(eventName ?? "").toLowerCase();
}

function isSignedEvent(event: string) {
  return (
    (event === "sign" ||
      event === "signed" ||
      event.includes("document_signed") ||
      event.includes("signer_signed") ||
      event.includes("signature_signed")) &&
    !event.includes("request") &&
    !event.includes("reminder") &&
    !event.includes("refused") &&
    !event.includes("failed") &&
    !event.includes("error")
  );
}

function isActionRequiredEvent(event: string) {
  return (
    event.includes("facematch_refused") ||
    event.includes("facial_biometrics_refused") ||
    event.includes("authentication_failed") ||
    event.includes("auth_failed") ||
    event.includes("refused") ||
    event.includes("refusal") ||
    event.includes("failed") ||
    event.includes("error") ||
    event.includes("invalid")
  );
}

function isCancelledEvent(event: string) {
  return (
    event.includes("cancel") ||
    event.includes("deadline") ||
    event.includes("expired")
  );
}

function isClosedEvent(event: string) {
  return (
    event.includes("close") ||
    event.includes("auto_close") ||
    event.includes("document_closed")
  );
}

export class ClicksignWebhookController {
  async handle(request: Request, response: Response) {
    if (env.CLICKSIGN_WEBHOOK_SECRET) {
      const providedSecret =
        request.query.secret ??
        request.headers["x-webhook-secret"] ??
        request.headers["x-clicksign-secret"];

      if (providedSecret !== env.CLICKSIGN_WEBHOOK_SECRET) {
        return response.status(401).json({
          message: "Webhook não autorizado",
        });
      }
    }

    const body = request.body;

    const eventName = getEventName(body);
    const envelopeId = getEnvelopeId(body);
    const documentId = getDocumentId(body);
    const signerId = getSignerId(body);

    const metadataContractId = getContractIdFromMetadata(body);

    const contractWhereConditions = [];

    if (metadataContractId) {
      contractWhereConditions.push({
        id: String(metadataContractId),
      });
    }

    if (envelopeId) {
      contractWhereConditions.push({
        clicksignEnvelopeId: String(envelopeId),
      });
    }

    if (documentId) {
      contractWhereConditions.push({
        clicksignDocumentId: String(documentId),
      });
    }

    const contract =
      contractWhereConditions.length > 0
        ? await prisma.contract.findFirst({
            where: {
              OR: contractWhereConditions,
            },
            include: {
              signers: true,
            },
          })
        : null;

    await prisma.clicksignWebhookEvent.create({
      data: {
        contractId: contract?.id ?? null,
        eventName: eventName ? String(eventName) : null,
        clicksignEnvelopeId: envelopeId
          ? String(envelopeId)
          : (contract?.clicksignEnvelopeId ?? null),
        clicksignDocumentId: documentId
          ? String(documentId)
          : (contract?.clicksignDocumentId ?? null),
        clicksignSignerId: signerId ? String(signerId) : null,
        payload: JSON.stringify(body),
      },
    });

    if (!contract) {
      return response.status(202).json({
        received: true,
        matched: false,
      });
    }

    const normalizedEvent = normalizeEventName(eventName);

    console.log("[CLICKSIGN_WEBHOOK_MATCHED]", {
      eventName,
      normalizedEvent,
      envelopeId,
      documentId,
      signerId,
      contractId: contract.id,
    });

    if (isActionRequiredEvent(normalizedEvent)) {
      if (signerId) {
        await prisma.contractSigner.updateMany({
          where: {
            contractId: contract.id,
            clicksignSignerId: String(signerId),
          },
          data: {
            status:
              normalizedEvent.includes("facematch") ||
              normalizedEvent.includes("facial_biometrics") ||
              normalizedEvent.includes("authentication")
                ? "AUTHENTICATION_FAILED"
                : "ACTION_REQUIRED",
          },
        });
      }

      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "ACTION_REQUIRED",
          signatureError: eventName
            ? `Ação necessária na assinatura: ${String(eventName)}`
            : "Ação necessária na assinatura.",
        },
      });

      return response.json({
        received: true,
        matched: true,
      });
    }

    if (isCancelledEvent(normalizedEvent)) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "CANCELLED",
          signatureError: eventName
            ? `Assinatura cancelada ou expirada: ${String(eventName)}`
            : "Assinatura cancelada ou expirada.",
        },
      });

      await prisma.contractSigner.updateMany({
        where: {
          contractId: contract.id,
          status: {
            not: "SIGNED",
          },
        },
        data: {
          status: "CANCELLED",
        },
      });

      return response.json({
        received: true,
        matched: true,
      });
    }

    if (isClosedEvent(normalizedEvent)) {
      await prisma.contractSigner.updateMany({
        where: {
          contractId: contract.id,
          status: {
            not: "SIGNED",
          },
        },
        data: {
          status: "SIGNED",
          signedAt: new Date(),
        },
      });

      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "SIGNED",
          signedAt: new Date(),
          signatureError: null,
        },
      });

      return response.json({
        received: true,
        matched: true,
      });
    }

    if (isSignedEvent(normalizedEvent) && signerId) {
      await prisma.contractSigner.updateMany({
        where: {
          contractId: contract.id,
          clicksignSignerId: String(signerId),
        },
        data: {
          status: "SIGNED",
          signedAt: new Date(),
        },
      });
    }

    const signers = await prisma.contractSigner.findMany({
      where: {
        contractId: contract.id,
      },
    });

    const signedCount = signers.filter(
      (signer: { status: string }) => signer.status === "SIGNED",
    ).length;

    const hasProblem = signers.some((signer: { status: string }) =>
      ["ACTION_REQUIRED", "AUTHENTICATION_FAILED", "REFUSED", "ERROR"].includes(
        signer.status,
      ),
    );

    if (hasProblem) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "ACTION_REQUIRED",
        },
      });
    } else if (signers.length > 0 && signedCount === signers.length) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "SIGNED",
          signedAt: new Date(),
          signatureError: null,
        },
      });
    } else if (signedCount > 0) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "PARTIALLY_SIGNED",
        },
      });
    }

    return response.json({
      received: true,
      matched: true,
    });
  }
}
