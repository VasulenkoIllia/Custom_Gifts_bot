import type { IncomingHttpHeaders } from "node:http";

function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) {
    return String(value[0] ?? "").trim();
  }
  return String(value ?? "").trim();
}

export function validateWebhookSecret(
  headers: IncomingHttpHeaders,
  expectedSecret: string,
  headerNames: string[],
): boolean {
  if (!expectedSecret) {
    return true;
  }

  for (const headerName of headerNames) {
    const value = readHeader(headers, headerName.toLowerCase());
    if (value && value === expectedSecret) {
      return true;
    }
  }

  return false;
}
