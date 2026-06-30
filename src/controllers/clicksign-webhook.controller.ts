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
    body?.data?.relationships?.envelope?.data?.id ??
    body?.data?.attributes?.envelope_id ??
    body?.data?.envelope_id ??
    null
  );
}

function getDocumentId(body: any) {
  return (
    body?.document?.id ??
    body?.data?.relationships?.document?.data?.id ??
    body?.data?.attributes?.document_id ??
    body?.data?.document_id ??
    null
  );
}

function getSignerId(body: any) {
  return (
    body?.signer?.id ??
    body?.data?.relationships?.signer?.data?.id ??
    body?.data?.attributes?.signer_id ??
    body?.data?.signer_id ??
    null
  );
}

function normalizeEventName(eventName?: string | null) {
  return String(eventName ?? "").toLowerCase();
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

    const contract = envelopeId
      ? await prisma.contract.findFirst({
          where: {
            clicksignEnvelopeId: envelopeId,
          },
          include: {
            signers: true,
          },
        })
      : null;

    await prisma.clicksignWebhookEvent.create({
      data: {
        contractId: contract?.id,
        eventName: eventName ? String(eventName) : null,
        clicksignEnvelopeId: envelopeId ? String(envelopeId) : null,
        clicksignDocumentId: documentId ? String(documentId) : null,
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

    if (normalizedEvent.includes("sign") && signerId) {
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

    if (normalizedEvent.includes("refusal")) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "REFUSED",
        },
      });

      if (signerId) {
        await prisma.contractSigner.updateMany({
          where: {
            contractId: contract.id,
            clicksignSignerId: String(signerId),
          },
          data: {
            status: "REFUSED",
          },
        });
      }

      return response.json({
        received: true,
        matched: true,
      });
    }

    if (
      normalizedEvent.includes("cancel") ||
      normalizedEvent.includes("deadline")
    ) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "CANCELLED",
        },
      });

      return response.json({
        received: true,
        matched: true,
      });
    }

    const signers = await prisma.contractSigner.findMany({
      where: {
        contractId: contract.id,
      },
    });

    const signedCount = signers.filter(
      (signer) => signer.status === "SIGNED",
    ).length;

    if (signers.length > 0 && signedCount === signers.length) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "SIGNED",
          signedAt: new Date(),
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

    if (
      normalizedEvent.includes("close") ||
      normalizedEvent.includes("auto_close") ||
      normalizedEvent.includes("document_closed")
    ) {
      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "SIGNED",
          signedAt: new Date(),
        },
      });
    }

    return response.json({
      received: true,
      matched: true,
    });
  }
}
