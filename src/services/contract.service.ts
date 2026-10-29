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

function formatZipCode(value?: string | null) {
  const digits = onlyDigits(value);
  if (digits.length !== 8) return value ?? "";
  return digits.replace(/^(\d{5})(\d{3})$/, "$1-$2");
}

function formatComplement(value?: string | null) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("-") || trimmed.startsWith(",")) {
    return ` ${trimmed}`;
  }
  return ` - ${trimmed}`;
}

function formatPhone(phone?: string | null) {
  const digits = onlyDigits(phone);
  if (digits.length === 11) {
    return digits.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  }
  if (digits.length === 10) {
    return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  }
  return phone ?? "";
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
      signatureEmail?: string | null;
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
    partnerEmail:
      profile?.signatureEmail?.trim() || params.requester.email,
    partnerPhone: profile?.phone ?? "",
    partnerResponsibleName: responsibleName,

    partnerDocumentLabel: documentType,
    partnerDocument: formattedDocument,

    partnerZipCode: formatZipCode(profile?.zipCode),
    partnerStreet: profile?.street ?? "",
    partnerNumber: profile?.number ?? "",
    partnerComplement: formatComplement(profile?.complement),
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

/**
 * Configuração de templates personalizados por parceiro/imobiliária.
 *
 * MECANISMO DE ROLLBACK RÁPIDO:
 * Para desativar imediatamente qualquer template customizado e voltar ao modelo
 * padrão para 100% das imobiliárias, basta alterar ENABLE_CUSTOM_TEMPLATES para false.
 */
const ENABLE_CUSTOM_TEMPLATES = true;

const COLINA_CUSTOM_TEMPLATE_PATH = path.resolve(
  process.cwd(),
  "src/templates/colina-rental-application-contract.docx",
);

const COLINA_NEW_TEMPLATE_PATH = path.resolve(
  process.cwd(),
  "src/templates/Termos garantia Doculoc 23.10.26 - Colina.docx",
);

const AMICI_CUSTOM_TEMPLATE_PATH = path.resolve(
  process.cwd(),
  "src/templates/amici-rental-application-contract.docx",
);

function resolveContractTemplatePath(requester?: {
  email?: string | null;
  realEstateProfile?: { cnpj?: string | null } | null;
}): string {
  if (!ENABLE_CUSTOM_TEMPLATES) {
    return env.CONTRACT_TEMPLATE_PATH;
  }

  const requesterEmail = (requester?.email ?? "").toLowerCase().trim();
  const requesterCnpj = (requester?.realEstateProfile?.cnpj ?? "").replace(/\D/g, "");

  const isColina =
    requesterEmail === "atendimento@imobiliariacolina.com.br" ||
    requesterEmail === "administracao@imobiliariacolina.com.br" ||
    requesterCnpj === "30793440000104";

  if (isColina) {
    if (fs.existsSync(COLINA_NEW_TEMPLATE_PATH)) {
      return COLINA_NEW_TEMPLATE_PATH;
    }
    if (fs.existsSync(COLINA_CUSTOM_TEMPLATE_PATH)) {
      return COLINA_CUSTOM_TEMPLATE_PATH;
    }
  }

  const isAmici =
    requesterEmail === "lucas@amicigestao.com.br" ||
    requesterCnpj === "53944193000103";

  if (isAmici && fs.existsSync(AMICI_CUSTOM_TEMPLATE_PATH)) {
    return AMICI_CUSTOM_TEMPLATE_PATH;
  }

  return env.CONTRACT_TEMPLATE_PATH;
}

async function renderAndUploadContractDocument(params: {
  application: any;
  templatePath: string;
}) {
  const { application, templatePath } = params;

  if (!fs.existsSync(templatePath)) {
    throw new AppError(500, "Template de contrato não encontrado");
  }

  if (env.STORAGE_DRIVER === "local") {
    fs.mkdirSync(env.CONTRACT_OUTPUT_DIR, {
      recursive: true,
    });
  }

  const templateBinary = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(templateBinary);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  const rentValueNumber = toNumber(application.rentValue);
  const condominiumValueNumber = toNumber(application.condominiumValue);
  const feesValueNumber = toNumber(application.feesValue);
  const packageSum =
    rentValueNumber + condominiumValueNumber + feesValueNumber;
  const packageValue =
    packageSum > 0 ? packageSum : toNumber(application.requestedExpense);
  const monthlyServiceFee = packageValue * 0.1;

  const partner = buildPartnerContractData({
    requester: application.requester,
  });

  const tenants =
    application.tenants && application.tenants.length > 0
      ? application.tenants.map((tenant: any) => {
          const formattedDoc = formatPartnerDocument({ document: tenant.document });
          const formattedPhone = formatPhone(tenant.phone);
          return {
            order: tenant.order,
            name: tenant.name,
            document: formattedDoc,
            email: tenant.email,
            phone: formattedPhone,
            tenantLine: `${tenant.order}. Nome: ${tenant.name} | Documento: ${formattedDoc} | E-mail: ${tenant.email} | Tel.: ${formattedPhone}`,
          };
        })
      : [
          {
            order: 1,
            name: application.tenantName ?? "",
            document: formatPartnerDocument({ document: application.tenantDocument }),
            email: application.tenantEmail ?? "",
            phone: formatPhone(application.tenantPhone),
            tenantLine: `1. Nome: ${application.tenantName ?? ""} | Documento: ${formatPartnerDocument({ document: application.tenantDocument })} | E-mail: ${application.tenantEmail ?? ""} | Tel.: ${formatPhone(application.tenantPhone)}`,
          },
        ];

  const mainTenant = tenants[0];
  const allTenantsLines = tenants.map((t: any) => t.tenantLine).join("\n\n");

  doc.render({
    tenantName: mainTenant.name,
    tenantDocument: mainTenant.document,
    tenantEmail: mainTenant.email,
    tenantPhone: mainTenant.phone,

    tenants,
    tenantCount: tenants.length,

    propertyZipCode: formatZipCode(application.propertyZipCode),
    propertyStreet: application.propertyStreet,
    propertyNumber: application.propertyNumber,
    propertyComplement: formatComplement(application.propertyComplement),
    propertyNeighborhood: application.propertyNeighborhood,
    propertyCity: application.propertyCity,
    propertyState: application.propertyState,

    rentValue: formatCurrency(application.rentValue),
    condominiumValue: formatCurrency(application.condominiumValue),
    feesValue: formatCurrency(application.feesValue ?? 0),
    iptuValue: formatCurrency(application.feesValue ?? 0),
    adhesionFee: formatCurrency(application.adhesionFee ?? 0),
    requestedExpense: formatCurrency(packageValue),

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

    tenantLine: allTenantsLines,
    partnerLine: [
      partner.partnerName,
      partner.partnerDocument
        ? `${partner.partnerDocumentLabel}: ${partner.partnerDocument}`
        : null,
      partner.partnerEmail ? `E-mail: ${partner.partnerEmail}` : null,
      partner.partnerPhone ? `Tel.: ${partner.partnerPhone}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
    propertyLine: [
      application.propertyStreet
        ? `${application.propertyStreet}${application.propertyNumber ? `, nº ${application.propertyNumber}` : ""}`
        : null,
      application.propertyComplement
        ? application.propertyComplement.trim()
        : null,
      application.propertyNeighborhood
        ? `Bairro: ${application.propertyNeighborhood}`
        : null,
      application.propertyCity && application.propertyState
        ? `${application.propertyCity}/${application.propertyState}`
        : null,
      application.propertyZipCode
        ? `CEP: ${formatZipCode(application.propertyZipCode)}`
        : null,
    ]
      .filter(Boolean)
      .join(" - "),

    generatedAt: new Intl.DateTimeFormat("pt-BR").format(new Date()),
  });

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

  return {
    uploadedFile,
    templateName: path.basename(templatePath),
  };
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

    const templatePath = resolveContractTemplatePath(application.requester);

    let renderResult: { uploadedFile: any; templateName: string };

    try {
      renderResult = await renderAndUploadContractDocument({
        application,
        templatePath,
      });
    } catch (error) {
      await prisma.contract.upsert({
        where: {
          applicationId: application.id,
        },
        create: {
          applicationId: application.id,
          status: "FAILED",
          templateName: path.basename(templatePath),
          errorMessage:
            error instanceof Error
              ? error.message
              : "Erro ao renderizar contrato",
        },
        update: {
          status: "FAILED",
          templateName: path.basename(templatePath),
          errorMessage:
            error instanceof Error
              ? error.message
              : "Erro ao renderizar contrato",
        },
      });

      throw new AppError(500, "Erro ao preencher o template do contrato");
    }

    const { uploadedFile, templateName } = renderResult;

    const contract = await prisma.$transaction(async (tx) => {
      const updatedContract = await tx.contract.upsert({
        where: {
          applicationId: application.id,
        },
        create: {
          applicationId: application.id,
          status: "GENERATED",
          templateName,

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
          templateName,

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

  async syncContractDocumentOnDownload(contractId: string) {
    const contract = await prisma.contract.findUnique({
      where: {
        id: contractId,
      },
      include: {
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

    if (!contract || !contract.application) {
      return null;
    }

    // Se já foi assinado pelas partes, não altera o documento físico assinado
    if (contract.signatureStatus === "SIGNED" || contract.signedAt) {
      return contract;
    }

    try {
      const templatePath = resolveContractTemplatePath(contract.application.requester);
      if (!fs.existsSync(templatePath)) {
        return contract;
      }

      const { uploadedFile, templateName } = await renderAndUploadContractDocument({
        application: contract.application,
        templatePath,
      });

      const updatedContract = await prisma.contract.update({
        where: { id: contract.id },
        data: {
          templateName,
          filePath: uploadedFile.filePath,
          fileName: uploadedFile.fileName,
          mimeType: uploadedFile.mimeType,
          sizeBytes: uploadedFile.sizeBytes,
          storageDriver: uploadedFile.storageDriver,
          storageBucket: uploadedFile.storageBucket,
          storageKey: uploadedFile.storageKey,
        },
        include: {
          application: true,
        },
      });

      return updatedContract;
    } catch (error) {
      console.error("[SYNC_CONTRACT_ON_DOWNLOAD_ERROR]", error);
      return contract;
    }
  }
}
