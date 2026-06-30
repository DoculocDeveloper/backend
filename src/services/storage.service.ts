import fs from "node:fs";
import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { Readable } from "node:stream";

type UploadInput = {
  buffer: Buffer;
  key: string;
  fileName: string;
  mimeType: string;
};

type UploadedFile = {
  storageDriver: "local" | "r2" | "s3";
  storageBucket?: string;
  storageKey: string;
  filePath?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export class StorageService {
  private s3Client?: S3Client;

  constructor() {
    if (env.STORAGE_DRIVER === "r2" || env.STORAGE_DRIVER === "s3") {
      this.s3Client = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID!,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        },
      });
    }
  }

  async upload(input: UploadInput): Promise<UploadedFile> {
    if (env.STORAGE_DRIVER === "local") {
      fs.mkdirSync(env.CONTRACT_OUTPUT_DIR, { recursive: true });

      const outputDir = path.resolve(env.CONTRACT_OUTPUT_DIR);
      const filePath = path.join(outputDir, input.fileName);

      fs.writeFileSync(filePath, input.buffer);

      return {
        storageDriver: "local",
        storageKey: filePath,
        filePath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.length,
      };
    }

    if (!this.s3Client) {
      throw new Error("S3 client não configurado");
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET!,
        Key: input.key,
        Body: input.buffer,
        ContentType: input.mimeType,
      }),
    );

    return {
      storageDriver: env.STORAGE_DRIVER,
      storageBucket: env.S3_BUCKET,
      storageKey: input.key,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
    };
  }

  async getObjectBuffer(params: {
    key?: string | null;
    filePath?: string | null;
  }) {
    if (env.STORAGE_DRIVER === "local") {
      const localPath = params.filePath ?? params.key;

      if (!localPath) {
        throw new Error("Caminho local do arquivo não informado");
      }

      return fs.readFileSync(localPath);
    }

    if (!params.key) {
      throw new Error("Chave do arquivo não informada");
    }

    const file = await this.getObjectStream({
      key: params.key,
    });

    const chunks: Buffer[] = [];

    for await (const chunk of file.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async getObjectStream(params: { key: string }) {
    if (!this.s3Client) {
      throw new Error("S3 client não configurado");
    }

    const object = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET!,
        Key: params.key,
      }),
    );

    if (!object.Body) {
      throw new Error("Arquivo não encontrado no storage");
    }

    if (!(object.Body instanceof Readable)) {
      throw new Error("Formato de stream inválido retornado pelo storage");
    }

    return {
      stream: object.Body,
      contentType: object.ContentType,
      contentLength: object.ContentLength,
    };
  }

  async getSignedDownloadUrl(params: {
    key: string;
    fileName?: string | null;
    expiresInSeconds?: number;
  }) {
    if (!this.s3Client) {
      throw new Error("S3 client não configurado");
    }

    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: params.key,
      ResponseContentDisposition: params.fileName
        ? `attachment; filename="${params.fileName}"`
        : undefined,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: params.expiresInSeconds ?? 300,
    });
  }
}
