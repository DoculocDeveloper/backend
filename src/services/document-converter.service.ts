import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../config/env.js";

const execFileAsync = promisify(execFile);

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^\w.-]+/g, "-");
}

export class DocumentConverterService {
  async convertDocxBufferToPdfBuffer(params: {
    buffer: Buffer;
    fileName: string;
  }) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "doculoc-contract-"));

    const safeFileName = sanitizeFileName(params.fileName);
    const inputPath = path.join(tempDir, safeFileName);

    const outputBaseName = safeFileName.replace(/\.docx$/i, "");
    const outputPath = path.join(tempDir, `${outputBaseName}.pdf`);

    try {
      fs.writeFileSync(inputPath, params.buffer);

      await execFileAsync(env.LIBREOFFICE_PATH, [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        tempDir,
        inputPath,
      ]);

      if (!fs.existsSync(outputPath)) {
        throw new Error("O PDF não foi gerado pelo LibreOffice.");
      }

      return fs.readFileSync(outputPath);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Erro desconhecido ao converter DOCX para PDF";

      throw new Error(`Erro ao converter contrato para PDF: ${message}`);
    } finally {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  }
}
