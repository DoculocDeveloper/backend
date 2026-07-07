import { Request, Response } from "express";
import { z } from "zod";
import { SignatureService } from "../services/signature.service.js";

const signatureService = new SignatureService();

const contractParamsSchema = z.object({
  id: z.string().uuid(),
});

export class SignatureController {
  async send(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await signatureService.sendContractToSignature({
      contractId: params.id,
      adminId: request.user!.id,
    });

    return response.status(201).json({
      contract,
    });
  }

  async status(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const result = await signatureService.getSignatureStatus({
      contractId: params.id,
      requesterId: request.user!.id,
      role: request.user!.role,
    });

    return response.json(result);
  }

  async resendNotification(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await signatureService.resendSignatureNotification({
      contractId: params.id,
    });

    return response.json({
      contract,
    });
  }

  async cancel(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await signatureService.cancelSignature({
      contractId: params.id,
    });

    return response.json({
      contract,
    });
  }

  async restart(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await signatureService.restartSignature({
      contractId: params.id,
      adminId: request.user!.id,
    });

    return response.json({
      contract,
    });
  }

  async reopenContractData(request: Request, response: Response) {
    const params = contractParamsSchema.parse(request.params);

    const contract = await signatureService.reopenContractData({
      contractId: params.id,
    });

    return response.json({
      contract,
    });
  }
}
