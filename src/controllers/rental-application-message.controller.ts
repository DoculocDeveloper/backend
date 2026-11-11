import { Request, Response } from "express";
import { RentalApplicationMessageService } from "../services/rental-application-message.service.js";
import { AppError } from "../middlewares/error-handler.js";

const messageService = new RentalApplicationMessageService();

export class RentalApplicationMessageController {
  async list(request: Request, response: Response) {
    const id = String(request.params.id);

    if (!id) {
      throw new AppError(400, "ID da consulta não informado");
    }

    const messages = await messageService.listMessages({
      applicationId: id,
      userId: request.user!.id,
      userRole: request.user!.role,
      userRealEstateId: request.user!.realEstateId,
    });

    return response.json({ messages });
  }

  async create(request: Request, response: Response) {
    const id = String(request.params.id);

    if (!id) {
      throw new AppError(400, "ID da consulta não informado");
    }

    const content = typeof request.body?.content === "string" ? request.body.content : "";
    const file = request.file;

    const message = await messageService.createMessage({
      applicationId: id,
      senderId: request.user!.id,
      senderRole: request.user!.role,
      senderRealEstateId: request.user!.realEstateId,
      content,
      file,
    });

    return response.status(201).json({ message });
  }

  async download(request: Request, response: Response) {
    const id = String(request.params.id);
    const messageId = String(request.params.messageId);

    if (!id || !messageId) {
      throw new AppError(400, "Parâmetros inválidos");
    }

    const { buffer, fileName, mimeType } = await messageService.getAttachmentBuffer({
      applicationId: id,
      messageId,
      userId: request.user!.id,
      userRole: request.user!.role,
      userRealEstateId: request.user!.realEstateId,
    });

    response.setHeader("Content-Type", mimeType);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );

    return response.send(buffer);
  }
}
