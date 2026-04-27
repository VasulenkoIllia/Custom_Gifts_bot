import { createHash } from "node:crypto";

const EVENT_ORDER_STATUS_CHANGED = "order.change_order_status";

export type KeycrmWebhookEvent = {
  event: string;
  context?: {
    id?: number | string;
    status_id?: number | string;
    status_changed_at?: string;
    updated_at?: string;
    source_uuid?: string;
    force?: boolean;
  };
};

export type OrderWebhookCandidate = {
  orderId: string;
  statusId: number | null;
  statusChangedAt: string | null;
  sourceUuid: string | null;
  idempotencyKey: string;
  force?: boolean;
};

export type NormalizeKeycrmWebhookResult = {
  candidates: OrderWebhookCandidate[];
  skipped: Array<{ reason: string; event: string | null }>;
  totalEvents: number;
};

export function extractKeycrmWebhookEvents(payload: unknown): KeycrmWebhookEvent[] {
  const events: KeycrmWebhookEvent[] = [];

  const addCandidate = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const direct = candidate as KeycrmWebhookEvent;
    if (direct.event && direct.context) {
      events.push(direct);
      return;
    }

    const wrapped = (candidate as { body?: unknown }).body;
    if (!wrapped || typeof wrapped !== "object") {
      return;
    }

    const wrappedEvent = wrapped as KeycrmWebhookEvent;
    if (wrappedEvent.event && wrappedEvent.context) {
      events.push(wrappedEvent);
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(addCandidate);
    return events;
  }

  addCandidate(payload);
  return events;
}

function normalizeStatusId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeOrderId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function buildIdempotencyKey(eventPayload: KeycrmWebhookEvent, orderId: string): string {
  const statusId = normalizeStatusId(eventPayload.context?.status_id);
  const statusChangedAt = normalizeOptionalString(
    eventPayload.context?.status_changed_at ?? eventPayload.context?.updated_at,
  );
  const sourceUuid = normalizeOptionalString(eventPayload.context?.source_uuid);

  const signatureSource = JSON.stringify({
    event: eventPayload.event,
    orderId,
    statusId,
    statusChangedAt,
    sourceUuid,
  });

  const hash = createHash("sha1").update(signatureSource).digest("hex");
  return `keycrm:${hash}`;
}

export function normalizeKeycrmWebhook(payload: unknown): NormalizeKeycrmWebhookResult {
  const events = extractKeycrmWebhookEvents(payload);
  const result: NormalizeKeycrmWebhookResult = {
    candidates: [],
    skipped: [],
    totalEvents: events.length,
  };

  for (const eventPayload of events) {
    if (eventPayload.event !== EVENT_ORDER_STATUS_CHANGED) {
      result.skipped.push({
        reason: `unsupported_event:${eventPayload.event}`,
        event: eventPayload.event,
      });
      continue;
    }

    const orderId = normalizeOrderId(eventPayload.context?.id);
    if (!orderId) {
      result.skipped.push({
        reason: "missing_context_id",
        event: eventPayload.event,
      });
      continue;
    }

    result.candidates.push({
      orderId,
      statusId: normalizeStatusId(eventPayload.context?.status_id),
      statusChangedAt: normalizeOptionalString(
        eventPayload.context?.status_changed_at ?? eventPayload.context?.updated_at,
      ),
      sourceUuid: normalizeOptionalString(eventPayload.context?.source_uuid),
      idempotencyKey: buildIdempotencyKey(eventPayload, orderId),
      force: eventPayload.context?.force === true ? true : undefined,
    });
  }

  return result;
}
