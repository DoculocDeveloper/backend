import { prisma } from "../lib/prisma.js";
import { AppError } from "../middlewares/error-handler.js";
import { UserRole } from "../domain/roles.js";
import { StorageService } from "./storage.service.js";

const storageService = new StorageService();

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

export class RentalApplicationMessageService {
  private async ensureCanAccessApplication(params: {
    applicationId: string;
    userId: string;
    userRole: string;
    userRealEstateId?: string | null;
  }) {
    const application = await prisma.rentalApplication.findUnique({
      where: { id: params.applicationId },
      select: { id: true, requesterId: true },
    });

    if (!application) {
      throw new AppError(404, "Consulta não encontrada");
    }

    if (params.userRole === UserRole.SELLER) {
      throw new AppError(403, "Vendedores não possuem permissão de acesso ao chat da consulta");
    }

    if (
      params.userRole === UserRole.ADMIN ||
      params.userRole === UserRole.ACCOUNT_EXECUTIVE
    ) {
      return application;
    }

    if (application.requesterId === params.userId) {
      return application;
    }

    throw new AppError(403, "Acesso negado a esta consulta");
  }

  async listMessages(params: {
    applicationId: string;
    userId: string;
    userRole: string;
    userRealEstateId?: string | null;
  }) {
    await this.ensureCanAccessApplication(params);

    const messages = await prisma.rentalApplicationMessage.findMany({
      where: { applicationId: params.applicationId },
      orderBy: { createdAt: "asc" },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // Mark as read unread incoming messages
    const isStaff =
      params.userRole === UserRole.ADMIN ||
      params.userRole === UserRole.ACCOUNT_EXECUTIVE;

    const unreadIds = messages
      .filter((m) => m.readAt === null && m.isStaff !== isStaff)
      .map((m) => m.id);

    if (unreadIds.length > 0) {
      await prisma.rentalApplicationMessage.updateMany({
        where: { id: { in: unreadIds } },
        data: { readAt: new Date() },
      });
    }

    return messages;
  }

  async createMessage(params: {
    applicationId: string;
    senderId: string;
    senderRole: string;
    senderRealEstateId?: string | null;
    content?: string;
    file?: Express.Multer.File;
  }) {
    await this.ensureCanAccessApplication({
      applicationId: params.applicationId,
      userId: params.senderId,
      userRole: params.senderRole,
      userRealEstateId: params.senderRealEstateId,
    });

    const cleanContent = params.content?.trim() || "";

    if (!cleanContent && !params.file) {
      throw new AppError(400, "Envie uma mensagem de texto ou um arquivo.");
    }

    let attachmentKey: string | null = null;
    let attachmentFileName: string | null = null;
    let attachmentMimeType: string | null = null;
    let attachmentSizeBytes: number | null = null;

    if (params.file) {
      if (params.file.size > MAX_FILE_SIZE_BYTES) {
        throw new AppError(
          400,
          "O arquivo excede o limite máximo permitido de 15MB.",
        );
      }

      if (!ALLOWED_MIME_TYPES.includes(params.file.mimetype)) {
        throw new AppError(
          400,
          "Tipo de arquivo não permitido. Envie apenas PDF, imagens (JPG, PNG, WEBP) ou DOCX.",
        );
      }

      const safeOriginalName = params.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageKey = `chat/${params.applicationId}/${Date.now()}-${safeOriginalName}`;

      const uploaded = await storageService.upload({
        buffer: params.file.buffer,
        key: storageKey,
        fileName: safeOriginalName,
        mimeType: params.file.mimetype,
      });

      attachmentKey = uploaded.storageKey;
      attachmentFileName = params.file.originalname;
      attachmentMimeType = params.file.mimetype;
      attachmentSizeBytes = params.file.size;
    }

    const isStaff =
      params.senderRole === UserRole.ADMIN ||
      params.senderRole === UserRole.ACCOUNT_EXECUTIVE;

    const message = await prisma.rentalApplicationMessage.create({
      data: {
        applicationId: params.applicationId,
        senderId: params.senderId,
        isStaff,
        content: cleanContent,
        attachmentKey,
        attachmentFileName,
        attachmentMimeType,
        attachmentSizeBytes,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return message;
  }

  async getAttachmentBuffer(params: {
    applicationId: string;
    messageId: string;
    userId: string;
    userRole: string;
    userRealEstateId?: string | null;
  }) {
    await this.ensureCanAccessApplication({
      applicationId: params.applicationId,
      userId: params.userId,
      userRole: params.userRole,
      userRealEstateId: params.userRealEstateId,
    });

    const message = await prisma.rentalApplicationMessage.findFirst({
      where: {
        id: params.messageId,
        applicationId: params.applicationId,
      },
    });

    if (!message || !message.attachmentKey) {
      throw new AppError(404, "Anexo não encontrado");
    }

    const buffer = await storageService.getObjectBuffer({
      key: message.attachmentKey,
    });

    return {
      buffer,
      fileName: message.attachmentFileName || "anexo",
      mimeType: message.attachmentMimeType || "application/octet-stream",
    };
  }
}

