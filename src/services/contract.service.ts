// Libs
import { prisma } from "../lib/prisma.js";
import Docxtemplater from "docxtemplater";
import path from "node:path";
import PizZip from "pizzip";
import fs from "node:fs";

// Errors
import { AppError } from "../middlewares/error-handler.js";

// Types
import { env } from "../config/env.js";

// Services
import { StorageService } from "./storage.service.js";

const storageService = new StorageService();

function toNumber(value: unknown) {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value);
}

function formatCurrency(value: unknown) {
  const numberValue = toNumber(value);

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(numberValue);
}

function onlyDigits(value?: string | null) {
  return String(value ?? "").replace(/\D/g, "");
}

function formatCpf(value?: string | null) {
  const digits = onlyDigits(value);

  if (digits.length !== 11) return value ?? "";

  return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

function formatCnpj(value?: string | null) {
  const digits = onlyDigits(value);

  if (digits.length !== 14) return value ?? "";

  return digits.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
}

function formatPartnerDocument(params: {
  document?: string | null;
  documentType?: string | null;
}) {
  if (params.documentType === "CPF") {
    return formatCpf(params.document);
  }

  if (params.documentType === "CNPJ") {
    return formatCnpj(params.document);
  }

  const digits = onlyDigits(params.document);

  if (digits.length === 11) return formatCpf(digits);
  if (digits.length === 14) return formatCnpj(digits);

  return params.document ?? "";
}

function buildPartnerContractData(params: {
  requester: {
    name: string;
    email: string;
    realEstateProfile?: {
      profileType?: string | null;
      name?: string | null;
      cnpj?: string | null;
      documentType?: string | null;
      document?: string | null;
      phone?: string | null;
      responsibleName?: string | null;
      zipCode?: string | null;
      street?: string | null;
      number?: string | null;
      complement?: string | null;
      neighborhood?: string | null;
      city?: string | null;
      state?: string | null;
    } | null;
  };
}) {
  const profile = params.requester.realEstateProfile;

  const isAutonomousBroker = profile?.profileType === "AUTONOMOUS_BROKER";

  const documentType = isAutonomousBroker ? "CPF" : "CNPJ";

  const rawDocument = profile?.document ?? profile?.cnpj ?? "";

  const formattedDocument = formatPartnerDocument({
    document: rawDocument,
    documentType: profile?.documentType ?? documentType,
  });

  const partnerName = profile?.name ?? params.requester.name;

  const responsibleName = profile?.responsibleName ?? params.requester.name;

  const addressLine = [
    profile?.street,
    profile?.number ? `nº ${profile.number}` : null,
    profile?.complement,
  ]
    .filter(Boolean)
    .join(", ");

  const cityLine = [
    profile?.neighborhood ? `bairro ${profile.neighborhood}` : null,
    profile?.city,
    profile?.state,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    isAutonomousBroker,

    partnerType: isAutonomousBroker ? "AUTONOMOUS_BROKER" : "COMPANY",

    partnerTypeLabel: isAutonomousBroker ? "Corretor autônomo" : "Imobiliária",

    partnerSectionTitle: isAutonomousBroker
      ? "DADOS DO CORRETOR AUTÔNOMO"
      : "DADOS DA IMOBILIÁRIA",

    partnerSignatureLabel: isAutonomousBroker
      ? "CORRETOR(A) AUTÔNOMO(A)"
      : "ADMINISTRADOR(A) / IMOBILIÁRIA",

    partnerName,
    partnerEmail: params.requester.email,
    partnerPhone: profile?.phone ?? "",
    partnerResponsibleName: responsibleName,

    partnerDocumentLabel: documentType,
    partnerDocument: formattedDocument,

    partnerZipCode: profile?.zipCode ?? "",
    partnerStreet: profile?.street ?? "",
    partnerNumber: profile?.number ?? "",
    partnerComplement: profile?.complement ?? "",
    partnerNeighborhood: profile?.neighborhood ?? "",
    partnerCity: profile?.city ?? "",
    partnerState: profile?.state ?? "",

    partnerAddressLine: addressLine,
    partnerCityLine: cityLine,
  };
}

function assertContractDataIsComplete(application: any) {
  const requiredFields = [
    "propertyZipCode",
    "propertyStreet",
    "propertyNumber",
    "propertyNeighborhood",
    "propertyCity",
    "propertyState",
  ];

  const missingFields = requiredFields.filter((field) => !application[field]);

  if (missingFields.length > 0) {
    throw new AppError(
      400,
      `Dados obrigatórios ausentes para gerar contrato: ${missingFields.join(", ")}`,
    );
  }

  if (!application.tenants || application.tenants.length === 0) {
    throw new AppError(
      400,
      "Informe pelo menos um locatário para gerar o contrato.",
    );
  }
}

export class ContractService {
  async generateContract(params: { applicationId: string; adminId: string }) {
    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
      include: {
        contract: true,
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
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (application.status !== "WAITING_ADMIN_CONTRACT") {
      throw new AppError(
        400,
        "Essa consulta ainda não está pronta para geração de contrato.",
      );
    }

    assertContractDataIsComplete(application);

    if (!fs.existsSync(env.CONTRACT_TEMPLATE_PATH)) {
      throw new AppError(500, "Template de contrato não encontrado");
    }

    if (env.STORAGE_DRIVER === "local") {
      fs.mkdirSync(env.CONTRACT_OUTPUT_DIR, {
        recursive: true,
      });
    }

    const templateBinary = fs.readFileSync(
      env.CONTRACT_TEMPLATE_PATH,
      "binary",
    );

    const zip = new PizZip(templateBinary);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    const packageValue = toNumber(application.requestedExpense);
    const monthlyServiceFee = packageValue * 0.1;

    const partner = buildPartnerContractData({
      requester: application.requester,
    });

    const tenants =
      application.tenants.length > 0
        ? application.tenants.map((tenant) => ({
            order: tenant.order,
            name: tenant.name,
            document: tenant.document,
            email: tenant.email,
            phone: tenant.phone,
            tenantLine: `${tenant.order}. Nome: ${tenant.name} | Documento: ${tenant.document} | E-mail: ${tenant.email} | Tel.: ${tenant.phone}`,
          }))
        : [
            {
              order: 1,
              name: application.tenantName ?? "",
              document: application.tenantDocument ?? "",
              email: application.tenantEmail ?? "",
              phone: application.tenantPhone ?? "",
              tenantLine: `1. Nome: ${application.tenantName ?? ""} | Documento: ${application.tenantDocument ?? ""} | E-mail: ${application.tenantEmail ?? ""} | Tel.: ${application.tenantPhone ?? ""}`,
            },
          ];

    const mainTenant = tenants[0];

    try {
      doc.render({
        tenantName: mainTenant.name,
        tenantDocument: mainTenant.document,
        tenantEmail: mainTenant.email,
        tenantPhone: mainTenant.phone,

        tenants,
        tenantCount: tenants.length,

        propertyZipCode: application.propertyZipCode,
        propertyStreet: application.propertyStreet,
        propertyNumber: application.propertyNumber,
        propertyComplement: application.propertyComplement ?? "",
        propertyNeighborhood: application.propertyNeighborhood,
        propertyCity: application.propertyCity,
        propertyState: application.propertyState,

        rentValue: formatCurrency(application.rentValue),
        condominiumValue: formatCurrency(application.condominiumValue),
        adhesionFee: formatCurrency(application.adhesionFee ?? 0),
        requestedExpense: formatCurrency(application.requestedExpense),

        monthlyServiceFee: formatCurrency(monthlyServiceFee),

        partnerType: partner.partnerType,
        partnerTypeLabel: partner.partnerTypeLabel,
        partnerSectionTitle: partner.partnerSectionTitle,
        partnerSignatureLabel: partner.partnerSignatureLabel,

        partnerName: partner.partnerName,
        partnerEmail: partner.partnerEmail,
        partnerPhone: partner.partnerPhone,
        partnerResponsibleName: partner.partnerResponsibleName,
        partnerDocumentLabel: partner.partnerDocumentLabel,
        partnerDocument: partner.partnerDocument,

        partnerZipCode: partner.partnerZipCode,
        partnerStreet: partner.partnerStreet,
        partnerNumber: partner.partnerNumber,
        partnerComplement: partner.partnerComplement,
        partnerNeighborhood: partner.partnerNeighborhood,
        partnerCity: partner.partnerCity,
        partnerState: partner.partnerState,

        partnerAddressLine: partner.partnerAddressLine,
        partnerCityLine: partner.partnerCityLine,

        // Compatibilidade com o template antigo
        realEstateName: partner.partnerName,
        realEstateEmail: partner.partnerEmail,
        realEstateCnpj: partner.partnerDocument,
        realEstatePhone: partner.partnerPhone,
        realEstateResponsibleName: partner.partnerResponsibleName,
        realEstateZipCode: partner.partnerZipCode,
        realEstateStreet: partner.partnerStreet,
        realEstateNumber: partner.partnerNumber,
        realEstateComplement: partner.partnerComplement,
        realEstateNeighborhood: partner.partnerNeighborhood,
        realEstateCity: partner.partnerCity,
        realEstateState: partner.partnerState,

        realEstateAddressLine: partner.partnerAddressLine,
        realEstateCityLine: partner.partnerCityLine,

        generatedAt: new Intl.DateTimeFormat("pt-BR").format(new Date()),
      });
    } catch (error) {
      await prisma.contract.upsert({
        where: {
          applicationId: application.id,
        },
        create: {
          applicationId: application.id,
          status: "FAILED",
          templateName: path.basename(env.CONTRACT_TEMPLATE_PATH),
          errorMessage:
            error instanceof Error
              ? error.message
              : "Erro ao renderizar contrato",
        },
        update: {
          status: "FAILED",
          errorMessage:
            error instanceof Error
              ? error.message
              : "Erro ao renderizar contrato",
        },
      });

      throw new AppError(500, "Erro ao preencher o template do contrato");
    }

    const buffer = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    const fileName = `contrato-${application.id}.docx`;
    const storageKey = `contracts/${new Date().getFullYear()}/${application.id}/${fileName}`;

    const uploadedFile = await storageService.upload({
      buffer,
      key: storageKey,
      fileName,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const contract = await prisma.$transaction(async (tx) => {
      const updatedContract = await tx.contract.upsert({
        where: {
          applicationId: application.id,
        },
        create: {
          applicationId: application.id,
          status: "GENERATED",
          templateName: path.basename(env.CONTRACT_TEMPLATE_PATH),

          filePath: uploadedFile.filePath,
          fileName: uploadedFile.fileName,
          mimeType: uploadedFile.mimeType,
          sizeBytes: uploadedFile.sizeBytes,
          storageDriver: uploadedFile.storageDriver,
          storageBucket: uploadedFile.storageBucket,
          storageKey: uploadedFile.storageKey,

          generatedById: params.adminId,
          generatedAt: new Date(),
        },
        update: {
          status: "GENERATED",

          filePath: uploadedFile.filePath,
          fileName: uploadedFile.fileName,
          mimeType: uploadedFile.mimeType,
          sizeBytes: uploadedFile.sizeBytes,
          storageDriver: uploadedFile.storageDriver,
          storageBucket: uploadedFile.storageBucket,
          storageKey: uploadedFile.storageKey,

          generatedById: params.adminId,
          generatedAt: new Date(),
          errorMessage: null,

          clicksignEnvelopeId: null,
          clicksignDocumentId: null,
          signatureStatus: "NOT_SENT",
          signatureError: null,
          sentToSignatureAt: null,
          signedAt: null,
        },
      });

      await tx.contractSigner.deleteMany({
        where: {
          contractId: updatedContract.id,
        },
      });

      await tx.rentalApplication.update({
        where: {
          id: application.id,
        },
        data: {
          status: "CONTRACT_GENERATED",
        },
      });

      return updatedContract;
    });

    return contract;
  }
}
