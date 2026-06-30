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
    const realEstateProfile = application.requester.realEstateProfile;

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
      const realEstateAddressLine = [
        realEstateProfile?.street,
        realEstateProfile?.number ? `nº ${realEstateProfile.number}` : null,
        realEstateProfile?.complement,
      ]
        .filter(Boolean)
        .join(", ");

      const realEstateCityLine = [
        realEstateProfile?.neighborhood
          ? `bairro ${realEstateProfile.neighborhood}`
          : null,
        realEstateProfile?.city,
        realEstateProfile?.state,
      ]
        .filter(Boolean)
        .join(", ");

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

        realEstateName: realEstateProfile?.name ?? application.requester.name,
        realEstateEmail: application.requester.email,
        realEstateCnpj: realEstateProfile?.cnpj ?? "",
        realEstatePhone: realEstateProfile?.phone ?? "",
        realEstateResponsibleName:
          realEstateProfile?.responsibleName ?? application.requester.name,
        realEstateZipCode: realEstateProfile?.zipCode ?? "",
        realEstateStreet: realEstateProfile?.street ?? "",
        realEstateNumber: realEstateProfile?.number ?? "",
        realEstateComplement: realEstateProfile?.complement ?? "",
        realEstateNeighborhood: realEstateProfile?.neighborhood ?? "",
        realEstateCity: realEstateProfile?.city ?? "",
        realEstateState: realEstateProfile?.state ?? "",

        realEstateAddressLine,
        realEstateCityLine,

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
