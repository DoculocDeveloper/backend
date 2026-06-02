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
    "tenantName",
    "tenantDocument",
    "tenantEmail",
    "tenantPhone",
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
}

export class ContractService {
  async generateContract(params: { applicationId: string; adminId: string }) {
    const application = await prisma.rentalApplication.findUnique({
      where: {
        id: params.applicationId,
      },
      include: {
        contract: true,
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
        "Essa consulta ainda não está pronta para geração de contrato",
      );
    }

    assertContractDataIsComplete(application);

    if (!fs.existsSync(env.CONTRACT_TEMPLATE_PATH)) {
      throw new AppError(500, "Template de contrato não encontrado");
    }

    fs.mkdirSync(env.CONTRACT_OUTPUT_DIR, {
      recursive: true,
    });

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
    const feeValue = toNumber(application.feesValue);
    const monthlyServiceFee = packageValue * 0.1;
    const realEstateProfile = application.requester.realEstateProfile;

    try {
      doc.render({
        tenantName: application.tenantName,
        tenantDocument: application.tenantDocument,
        tenantEmail: application.tenantEmail,
        tenantPhone: application.tenantPhone,

        propertyZipCode: application.propertyZipCode,
        propertyStreet: application.propertyStreet,
        propertyNumber: application.propertyNumber,
        propertyComplement: application.propertyComplement ?? "",
        propertyNeighborhood: application.propertyNeighborhood,
        propertyCity: application.propertyCity,
        propertyState: application.propertyState,

        rentValue: formatCurrency(application.rentValue),
        condominiumValue: formatCurrency(application.condominiumValue),
        feesValue: formatCurrency(application.feesValue),
        requestedExpense: formatCurrency(application.requestedExpense),

        monthlyServiceFee: formatCurrency(monthlyServiceFee),

        realEstateName: realEstateProfile?.name ?? application.requester.name,
        realEstateEmail: application.requester.email,
        realEstateCnpj: realEstateProfile?.cnpj ?? "",
        realEstatePhone: realEstateProfile?.phone ?? "",
        realEstateResponsibleName:
          realEstateProfile?.responsibleName ?? application.requester.name,

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
    const outputDir = path.resolve(env.CONTRACT_OUTPUT_DIR);
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, buffer);

    const contract = await prisma.$transaction(async (tx) => {
      const updatedContract = await tx.contract.upsert({
        where: {
          applicationId: application.id,
        },
        create: {
          applicationId: application.id,
          status: "GENERATED",
          templateName: path.basename(env.CONTRACT_TEMPLATE_PATH),
          filePath,
          fileName,
          generatedById: params.adminId,
          generatedAt: new Date(),
        },
        update: {
          status: "GENERATED",
          filePath,
          fileName,
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
