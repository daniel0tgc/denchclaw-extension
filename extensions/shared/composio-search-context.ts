import { createHmac, timingSafeEqual } from "node:crypto";

export type ComposioSearchExecutionMode = "gateway_tool_router" | "local_catalog_mcp";

export type ComposioSearchContext = {
  version: 1;
  mode: ComposioSearchExecutionMode;
  app: string;
  tool_name: string;
  session_id?: string;
  account?: string;
  account_required?: boolean;
  issued_at: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function fromBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

function validateContext(value: unknown): ComposioSearchContext | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const version = record.version;
  const mode = record.mode;
  const app = record.app;
  const toolName = record.tool_name;
  const sessionId = record.session_id;
  const account = record.account;
  const accountRequired = record.account_required;
  const issuedAt = record.issued_at;
  if (
    version !== 1
    || (mode !== "gateway_tool_router" && mode !== "local_catalog_mcp")
    || typeof app !== "string"
    || app.trim().length === 0
    || typeof toolName !== "string"
    || toolName.trim().length === 0
    || (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0))
    || (account !== undefined && (typeof account !== "string" || account.trim().length === 0))
    || (accountRequired !== undefined && typeof accountRequired !== "boolean")
    || typeof issuedAt !== "string"
    || issuedAt.trim().length === 0
  ) {
    return null;
  }

  return {
    version: 1,
    mode,
    app: app.trim(),
    tool_name: toolName.trim(),
    ...(typeof sessionId === "string" ? { session_id: sessionId.trim() } : {}),
    ...(typeof account === "string" ? { account: account.trim() } : {}),
    ...(accountRequired === true ? { account_required: true } : {}),
    issued_at: issuedAt.trim(),
  };
}

export function createComposioSearchContextSecret(params: {
  workspaceDir?: string | null;
  gatewayUrl?: string | null;
  apiKey?: string | null;
}): string {
  const seed = [
    params.workspaceDir?.trim() ?? "",
    params.gatewayUrl?.trim() ?? "",
    params.apiKey?.trim() ?? "",
  ].join("|");
  return seed || "denchclaw-composio-search";
}

export function signComposioSearchContext(
  context: ComposioSearchContext,
  secret: string,
): string {
  const payload = JSON.stringify(context);
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${toBase64Url(payload)}.${signature}`;
}

export function verifyComposioSearchContext(
  token: string,
  secret: string,
): ComposioSearchContext | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return null;
  }

  const encodedPayload = token.slice(0, dot);
  const encodedSignature = token.slice(dot + 1);
  const payload = fromBase64Url(encodedPayload);
  if (!payload) {
    return null;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const actualBytes = Buffer.from(encodedSignature, "utf-8");
  const expectedBytes = Buffer.from(expectedSignature, "utf-8");
  if (
    actualBytes.length !== expectedBytes.length
    || !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    return validateContext(JSON.parse(payload));
  } catch {
    return null;
  }
}
