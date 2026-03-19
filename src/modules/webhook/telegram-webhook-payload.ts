export type TelegramReactionType = {
  type?: string;
  emoji?: string;
};

export type TelegramReactionCountEntry = {
  type?: TelegramReactionType;
  total_count?: number;
};

export type TelegramReactionCountPayload = {
  update_id?: number;
  message_reaction_count?: {
    chat?: { id?: number | string };
    message_id?: number;
    reactions?: TelegramReactionCountEntry[];
  };
};

export type TelegramWebhookNormalized = {
  updateId: number | null;
  chatId: string | null;
  messageId: number | null;
  heartCount: number | null;
};

export function extractTelegramUpdates(payload: unknown): TelegramReactionCountPayload[] {
  const updates: TelegramReactionCountPayload[] = [];

  const addCandidate = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const direct = candidate as TelegramReactionCountPayload;
    if (
      Number.isFinite(Number(direct.update_id)) ||
      Boolean(direct.message_reaction_count)
    ) {
      updates.push(direct);
      return;
    }

    const wrapped = (candidate as { result?: unknown }).result;
    if (Array.isArray(wrapped)) {
      wrapped.forEach(addCandidate);
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(addCandidate);
    return updates;
  }

  addCandidate(payload);
  return updates;
}

function normalizeHeartCount(
  reactions: TelegramReactionCountEntry[] | undefined,
  trackedEmojis: Set<string>,
): number {
  const list = Array.isArray(reactions) ? reactions : [];
  let total = 0;

  for (const item of list) {
    const emoji = String(item?.type?.emoji ?? "").trim();
    if (!emoji || !trackedEmojis.has(emoji)) {
      continue;
    }

    total += Number.parseInt(String(item?.total_count ?? 0), 10) || 0;
  }

  return total;
}

export function normalizeTelegramUpdates(
  payload: unknown,
  trackedHeartEmojis: string[] = ["❤️"],
): TelegramWebhookNormalized[] {
  const updates = extractTelegramUpdates(payload);
  const emojiSet = new Set(trackedHeartEmojis.map((item) => item.trim()).filter(Boolean));

  return updates.map((item) => {
    const messageReactionCount = item.message_reaction_count;
    return {
      updateId: Number.isFinite(Number(item.update_id)) ? Number(item.update_id) : null,
      chatId:
        messageReactionCount?.chat?.id !== undefined
          ? String(messageReactionCount.chat.id).trim() || null
          : null,
      messageId:
        Number.isFinite(Number(messageReactionCount?.message_id))
          ? Number(messageReactionCount?.message_id)
          : null,
      heartCount: emojiSet.size
        ? normalizeHeartCount(messageReactionCount?.reactions, emojiSet)
        : null,
    };
  });
}
