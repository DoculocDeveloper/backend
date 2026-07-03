// Configs
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

// Middlewares
import { AppError } from "../middlewares/error-handler.js";

// Services
import { DocumentConverterService } from "./document-converter.service.js";
import { ClicksignClient } from "./clicksign-client.js";
import { StorageService } from "./storage.service.js";

type PreparedSigner = {
  role: "TENANT" | "REAL_ESTATE" | "DOCULOC";
  name: string;
  email: string;
  phone?: string | null;
  document?: string | null;
};

const clicksignClient = new ClicksignClient();
const storageService = new StorageService();
const documentConverterService = new DocumentConverterService();

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toClicksignDeadline(date: Date) {
  return date.toISOString();
}

function onlyDigits(value?: string | null) {
  return value ? value.replace(/\D/g, "") : "";
}

function assertDoculocSignerConfigured() {
  if (
    !env.CLICKSIGN_DOCULOC_SIGNER_NAME ||
    !env.CLICKSIGN_DOCULOC_SIGNER_EMAIL
  ) {
    throw new AppError(
      500,
      "Signatário da Doculoc não configurado. Verifique CLICKSIGN_DOCULOC_SIGNER_NAME e CLICKSIGN_DOCULOC_SIGNER_EMAIL.",
    );
  }
}

function hasValidDocumentation(value?: string | null) {
  const digits = onlyDigits(value);

  return digits.length === 11 || digits.length === 14;
}

export class SignatureService {
  private buildSigners(contract: any): PreparedSigner[] {
    const application = contract.application;
    const realEstateProfile = application.requester.realEstateProfile;

    const tenants: PreparedSigner[] = application.tenants.map(
      (tenant: any) => ({
        role: "TENANT",
        name: tenant.name,
        email: tenant.email,
        phone: tenant.phone,
        document: tenant.document,
      }),
    );

    if (
      tenants.length === 0 &&
      application.tenantName &&
      application.tenantEmail
    ) {
      tenants.push({
        role: "TENANT",
        name: application.tenantName,
        email: application.tenantEmail,
        phone: application.tenantPhone,
        document: application.tenantDocument,
      });
    }

    const realEstateSigner: PreparedSigner = {
      role: "REAL_ESTATE",
      name:
        realEstateProfile?.responsibleName ??
        realEstateProfile?.name ??
        application.requester.name,
      email: application.requester.email,
      phone: realEstateProfile?.phone,
      document: realEstateProfile?.cnpj,
    };

    const doculocSigner: PreparedSigner = {
      role: "DOCULOC",
      name: env.CLICKSIGN_DOCULOC_SIGNER_NAME!,
      email: env.CLICKSIGN_DOCULOC_SIGNER_EMAIL!,
      phone: env.CLICKSIGN_DOCULOC_SIGNER_PHONE,
      document: env.CLICKSIGN_DOCULOC_SIGNER_DOCUMENT,
    };

    return [...tenants, realEstateSigner, doculocSigner].filter(
      (signer) => signer.name && signer.email,
    );
  }

  async sendContractToSignature(params: {
    contractId: string;
    adminId: string;
  }) {
    assertDoculocSignerConfigured();

    const contract = await prisma.contract.findUnique({
      where: {
        id: params.contractId,
      },
      include: {
        signers: true,
        application: {
          include: {
            tenants: {
              orderBy: {
                order: "asc",
              },
            },
            requester: {
              include: {
                realEstateProfile: true,
              },
            },
          },
        },
      },
    });

    if (!contract) {
      throw new AppError(404, "Contrato não encontrado");
    }

    if (contract.status !== "GENERATED") {
      throw new AppError(
        400,
        "O contrato precisa estar gerado antes de ser enviado para assinatura.",
      );
    }

    if (contract.signatureStatus === "SIGNED") {
      throw new AppError(400, "Este contrato já foi assinado.");
    }

    if (
      contract.signatureStatus === "SENT" ||
      contract.signatureStatus === "PARTIALLY_SIGNED"
    ) {
      throw new AppError(400, "Este contrato já foi enviado para assinatura.");
    }

    if (!contract.fileName) {
      throw new AppError(400, "Contrato sem nome de arquivo.");
    }

    const signers = this.buildSigners(contract);

    if (signers.length === 0) {
      throw new AppError(400, "Nenhum signatário encontrado para o contrato.");
    }

    const invalidTenantSigner = signers.find(
      (signer) =>
        signer.role === "TENANT" && !hasValidDocumentation(signer.document),
    );

    if (invalidTenantSigner) {
      throw new AppError(
        400,
        `Documento inválido para o locatário ${invalidTenantSigner.name}. Informe CPF ou CNPJ válido antes de enviar para assinatura.`,
        "INVALID_TENANT_DOCUMENT_FOR_SIGNATURE",
      );
    }

    const fileBuffer = await storageService.getObjectBuffer({
      key: contract.storageKey,
      filePath: contract.filePath,
    });

    const originalFileName =
      contract.fileName ?? `contrato-${contract.id}.docx`;

    const isDocx =
      contract.mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      originalFileName.toLowerCase().endsWith(".docx");

    const signatureFileBuffer = isDocx
      ? await documentConverterService.convertDocxBufferToPdfBuffer({
          buffer: fileBuffer,
          fileName: originalFileName,
        })
      : fileBuffer;

    const signatureFileName = isDocx
      ? originalFileName.replace(/\.docx$/i, ".pdf")
      : originalFileName;

    const signatureMimeType = isDocx
      ? "application/pdf"
      : (contract.mimeType ?? "application/pdf");

    const contentBase64DataUri = `data:${signatureMimeType};base64,${signatureFileBuffer.toString(
      "base64",
    )}`;

    const deadlineAt = toClicksignDeadline(
      addDays(new Date(), env.CLICKSIGN_DEADLINE_DAYS),
    );

    try {
      const envelope = await clicksignClient.createEnvelope({
        name: `Contrato Doculoc - ${contract.application.document}`,
        deadlineAt,
      });

      const envelopeId = envelope.data.id;

      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          clicksignEnvelopeId: envelopeId,
          signatureStatus: "ENVELOPE_CREATED",
          signatureError: null,
        },
      });

      const document = await clicksignClient.uploadDocument({
        envelopeId,
        filename: signatureFileName,
        contentBase64DataUri,
        metadata: {
          contractId: contract.id,
          applicationId: contract.applicationId,
          source: "doculoc",
          originalFileName,
          convertedToPdf: isDocx,
        },
      });

      const documentId = document.data.id;

      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          clicksignDocumentId: documentId,
        },
      });

      await prisma.contractSigner.deleteMany({
        where: {
          contractId: contract.id,
        },
      });

      const createdSigners = [];

      for (const signer of signers) {
        const signerDocument = onlyDigits(signer.document);

        const shouldSendDocumentation =
          signer.role === "TENANT" && [11, 14].includes(signerDocument.length);

        const clicksignSigner = await clicksignClient.createSigner({
          envelopeId,
          name: signer.name,
          email: signer.email,
          phoneNumber: onlyDigits(signer.phone) || null,
          documentation: shouldSendDocumentation ? signerDocument : null,
          group: 1,
        });

        const clicksignSignerId = clicksignSigner.data.id;

        await clicksignClient.createQualificationRequirement({
          envelopeId,
          documentId,
          signerId: clicksignSignerId,
        });

        const authenticationMethod =
          signer.role === "TENANT" ? "facial_biometrics" : "email";

        await clicksignClient.createAuthenticationRequirement({
          envelopeId,
          documentId,
          signerId: clicksignSignerId,
          auth: authenticationMethod,
        });

        const createdSigner = await prisma.contractSigner.create({
          data: {
            contractId: contract.id,
            role: signer.role,
            name: signer.name,
            email: signer.email,
            phone: onlyDigits(signer.phone) || null,
            document: onlyDigits(signer.document) || null,
            clicksignSignerId,
            status: "SENT",
          },
        });

        createdSigners.push(createdSigner);
      }

      await clicksignClient.activateEnvelope({
        envelopeId,
      });

      await clicksignClient.notifyEnvelope({
        envelopeId,
        message:
          "Você recebeu um contrato de Garantia Locatícia Doculoc para assinatura.",
      });

      const updatedContract = await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "SENT",
          signatureError: null,
          sentToSignatureAt: new Date(),
        },
        include: {
          signers: true,
        },
      });

      return updatedContract;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Erro ao enviar contrato para assinatura.";

      await prisma.contract.update({
        where: {
          id: contract.id,
        },
        data: {
          signatureStatus: "ERROR",
          signatureError: message,
        },
      });

      throw new AppError(500, message);
    }
  }

  async getSignatureStatus(params: {
    contractId: string;
    requesterId: string;
    role: string;
  }) {
    const contract = await prisma.contract.findUnique({
      where: {
        id: params.contractId,
      },
      include: {
        signers: {
          orderBy: {
            createdAt: "asc",
          },
        },
        application: true,
      },
    });

    if (!contract) {
      throw new AppError(404, "Contrato não encontrado");
    }

    const isAdmin = params.role === "ADMIN";
    const isOwner = contract.application.requesterId === params.requesterId;

    if (!isAdmin && !isOwner) {
      throw new AppError(403, "Acesso negado");
    }

    return {
      contract,
      signers: contract.signers,
    };
  }
}
