import type { IncomingMessage } from "node:http";
import { HttpError } from "./http-errors";

export function readRequestBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > limitBytes) {
        reject(new HttpError(413, "Payload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      reject(new HttpError(400, `Cannot read request body: ${error.message}`));
    });
  });
}

export function parseJsonOrThrow(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `Invalid JSON body: ${message}`);
  }
}
