import { env } from "../config/env.js";

type ClicksignDataResponse<T = any> = {
  data: {
    id: string;
    type: string;
    attributes?: T;
    relationships?: Record<string, unknown>;
  };
};

type ClicksignAuthMethod =
  | "email"
  | "sms"
  | "whatsapp"
  | "pix"
  | "facial_biometrics"
  | "biometric"
  | "identity_biometrics"
  | "official_document"
  | "liveness"
  | "selfie"
  | "documentscopy"
  | "address_proof"
  | "handwritten"
  | "icp_brasil"
  | "registro_civil"
  | "embedded_signature"
  | "presential"
  | "auto_signature";

function assertClicksignConfigured() {
  if (!env.CLICKSIGN_BASE_URL || !env.CLICKSIGN_ACCESS_TOKEN) {
    throw new Error(
      "Clicksign não configurada. Verifique CLICKSIGN_BASE_URL e CLICKSIGN_ACCESS_TOKEN.",
    );
  }
}

function onlyDigits(value?: string | null) {
  return value ? value.replace(/\D/g, "") : "";
}

function formatClicksignDocumentation(value?: string | null) {
  const digits = onlyDigits(value);

  if (digits.length === 11) {
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  }

  if (digits.length === 14) {
    return digits.replace(
      /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
      "$1.$2.$3/$4-$5",
    );
  }

  return null;
}

export class ClicksignClient {
  private async request<T>(path: string, init: RequestInit = {}) {
    assertClicksignConfigured();

    const response = await fetch(`${env.CLICKSIGN_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: env.CLICKSIGN_ACCESS_TOKEN!,
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        ...init.headers,
      },
    });

    const text = await response.text();

    let body: any = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = {
        raw: text,
      };
    }

    console.log("[CLICKSIGN_REQUEST]", {
      path,
      method: init.method ?? "GET",
      status: response.status,
      ok: response.ok,
      bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
    });

    if (!response.ok) {
      console.error("[CLICKSIGN_ERROR_RESPONSE]", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        body: JSON.stringify(body, null, 2),
      });

      const message =
        body?.errors?.[0]?.detail ??
        body?.errors?.[0]?.title ??
        body?.errors?.[0]?.source?.pointer ??
        body?.message ??
        body?.raw ??
        "Erro ao chamar API da Clicksign";

      throw new Error(message);
    }

    return body as T;
  }

  async createEnvelope(params: { name: string; deadlineAt: string }) {
    return this.request<ClicksignDataResponse>("/api/v3/envelopes", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "envelopes",
          attributes: {
            name: params.name,
            locale: "pt-BR",
            auto_close: true,
            remind_interval: 3,
            block_after_refusal: true,
            deadline_at: params.deadlineAt,
          },
        },
      }),
    });
  }

  async uploadDocument(params: {
    envelopeId: string;
    filename: string;
    contentBase64DataUri: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "documents",
            attributes: {
              filename: params.filename,
              content_base64: params.contentBase64DataUri,
              metadata: params.metadata ?? {},
            },
          },
        }),
      },
    );
  }

  async createSigner(params: {
    envelopeId: string;
    name: string;
    email: string;
    phoneNumber?: string | null;
    documentation?: string | null;
    group?: number;
  }) {
    const documentation = formatClicksignDocumentation(params.documentation);

    const attributes: Record<string, unknown> = {
      name: params.name,
      email: params.email,
      phone_number: params.phoneNumber ?? null,
      refusable: true,
      group: params.group ?? 1,
      communicate_events: {
        document_signed: "email",
        signature_request: "email",
        signature_reminder: "email",
      },
    };

    if (documentation) {
      attributes.has_documentation = true;
      attributes.documentation = documentation;
    }

    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}/signers`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "signers",
            attributes,
          },
        }),
      },
    );
  }

  async createQualificationRequirement(params: {
    envelopeId: string;
    documentId: string;
    signerId: string;
  }) {
    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}/requirements`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "requirements",
            attributes: {
              action: "agree",
              role: "sign",
            },
            relationships: {
              document: {
                data: {
                  type: "documents",
                  id: params.documentId,
                },
              },
              signer: {
                data: {
                  type: "signers",
                  id: params.signerId,
                },
              },
            },
          },
        }),
      },
    );
  }

  async createAuthenticationRequirement(params: {
    envelopeId: string;
    documentId: string;
    signerId: string;
    auth: ClicksignAuthMethod;
  }) {
    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}/requirements`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "requirements",
            attributes: {
              action: "provide_evidence",
              auth: params.auth,
            },
            relationships: {
              document: {
                data: {
                  type: "documents",
                  id: params.documentId,
                },
              },
              signer: {
                data: {
                  type: "signers",
                  id: params.signerId,
                },
              },
            },
          },
        }),
      },
    );
  }

  async activateEnvelope(params: { envelopeId: string }) {
    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: params.envelopeId,
            type: "envelopes",
            attributes: {
              status: "running",
            },
          },
        }),
      },
    );
  }

  async notifyEnvelope(params: { envelopeId: string; message?: string }) {
    return this.request<ClicksignDataResponse>(
      `/api/v3/envelopes/${params.envelopeId}/notifications`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "notifications",
            attributes: {
              message:
                params.message ??
                "Você recebeu um contrato Doculoc para assinatura.",
            },
          },
        }),
      },
    );
  }
}
