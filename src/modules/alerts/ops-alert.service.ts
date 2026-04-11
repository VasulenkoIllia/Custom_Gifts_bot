type OpsAlertLevel = "warning" | "error" | "critical";

type OpsAlertSendResult = { sent: boolean; deduplicated: boolean; error?: string };

type CreateOpsAlertServiceParams = {
  botToken: string;
  chatId: string;
  messageThreadId: string;
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
  dedupeWindowMs: number;
};

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(
    message.toLowerCase(),
  );
}

function formatAlertText(params: {
  level: OpsAlertLevel;
  module: string;
  title: string;
  orderId?: string;
  details?: string;
}): string {
  const lines: string[] = [];
  lines.push(`[${params.level.toUpperCase()}] ${params.module}`);
  lines.push(params.title);
  if (params.orderId) {
    lines.push(`order: ${params.orderId}`);
  }
  if (params.details) {
    lines.push(params.details);
  }
  return lines.join("\n");
}

export class OpsAlertService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly messageThreadId: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly dedupeWindowMs: number;
  private readonly dedupeMap = new Map<string, number>();

  constructor(params: CreateOpsAlertServiceParams) {
    this.botToken = String(params.botToken ?? "").trim();
    this.chatId = String(params.chatId ?? "").trim();
    this.messageThreadId = String(params.messageThreadId ?? "").trim();
    this.timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1_000, params.timeoutMs) : 15_000;
    this.retries = Number.isFinite(params.retries) ? Math.max(0, params.retries) : 2;
    this.retryBaseMs = Number.isFinite(params.retryBaseMs)
      ? Math.max(100, params.retryBaseMs)
      : 700;
    this.dedupeWindowMs = Number.isFinite(params.dedupeWindowMs)
      ? Math.max(0, params.dedupeWindowMs)
      : 60_000;
  }

  isEnabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(params: {
    level: OpsAlertLevel;
    module: string;
    title: string;
    orderId?: string;
    details?: string;
    dedupeKey?: string;
  }): Promise<OpsAlertSendResult> {
    if (!this.isEnabled()) {
      return { sent: false, deduplicated: false };
    }

    const dedupeKey =
      String(params.dedupeKey ?? "").trim() ||
      `${params.level}:${params.module}:${params.title}:${params.orderId ?? ""}`;
    const now = Date.now();
    const lastSentAt = this.dedupeMap.get(dedupeKey) ?? 0;
    if (this.dedupeWindowMs > 0 && now - lastSentAt < this.dedupeWindowMs) {
      return { sent: false, deduplicated: true };
    }

    const text = formatAlertText({
      level: params.level,
      module: params.module,
      title: params.title,
      orderId: params.orderId,
      details: params.details,
    });

    try {
      await this.sendMessage(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          service: "ops-alert",
          event: "ops_alert_send_failed",
          module: params.module,
          alertLevel: params.level,
          message,
        })}\n`,
      );
      return { sent: false, deduplicated: false, error: message };
    }

    this.dedupeMap.set(dedupeKey, now);
    this.cleanupDedupe(now);

    return { sent: true, deduplicated: false };
  }

  private cleanupDedupe(now: number): void {
    if (this.dedupeMap.size < 500) {
      return;
    }

    for (const [key, timestamp] of this.dedupeMap.entries()) {
      if (now - timestamp > this.dedupeWindowMs * 2) {
        this.dedupeMap.delete(key);
      }
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const maxAttempts = this.retries + 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            chat_id: this.chatId,
            message_thread_id: this.messageThreadId || undefined,
            text,
            disable_web_page_preview: true,
          }),
        });

        const bodyText = await response.text();
        if (response.ok) {
          return;
        }

        const statusCode = response.status;
        if (attempt < maxAttempts && isRetryableStatusCode(statusCode)) {
          await sleep(this.computeRetryDelay(attempt));
          continue;
        }

        throw new Error(`Ops alert send failed (${statusCode}): ${bodyText.slice(0, 300)}`);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await sleep(this.computeRetryDelay(attempt));
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Ops alert send failed.");
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private computeRetryDelay(attempt: number): number {
    const exponential = this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(300, this.retryBaseMs));
    return Math.min(15_000, exponential + jitter);
  }
}
