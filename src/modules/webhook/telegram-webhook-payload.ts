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
  message_reaction?: {
    chat?: { id?: number | string };
    message_id?: number;
    old_reaction?: TelegramReactionType[];
    new_reaction?: TelegramReactionType[];
  };
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
  emojiCounts: Record<string, number>;
};

export function extractTelegramUpdates(payload: unknown): TelegramReactionCountPayload[] {
  const updates: TelegramReactionCountPayload[] = [];

  const addCandidate = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const direct = candidate as TelegramReactionCountPayload;
    if (Boolean(direct.message_reaction_count) || Boolean(direct.message_reaction)) {
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

function normalizeTrackedCounts(
  reactions: TelegramReactionCountEntry[] | undefined,
  trackedEmojis: Set<string>,
): Record<string, number> {
  const list = Array.isArray(reactions) ? reactions : [];
  const counts: Record<string, number> = {};

  for (const item of list) {
    const emoji = String(item?.type?.emoji ?? "").trim();
    if (!emoji || !trackedEmojis.has(emoji)) {
      continue;
    }

    const value = Number.parseInt(String(item?.total_count ?? 0), 10) || 0;
    counts[emoji] = Math.max(0, value);
  }

  return counts;
}

function normalizeTrackedReactions(
  reactions: TelegramReactionType[] | undefined,
  trackedEmojis: Set<string>,
): Record<string, number> {
  const list = Array.isArray(reactions) ? reactions : [];
  const counts: Record<string, number> = {};

  for (const item of list) {
    const emoji = String(item?.emoji ?? "").trim();
    if (!emoji || !trackedEmojis.has(emoji)) {
      continue;
    }

    counts[emoji] = (counts[emoji] ?? 0) + 1;
  }

  return counts;
}

const HEART_EMOJIS = new Set<string>(["❤️", "❤", "♥️", "♥"]);

function normalizeHeartCount(emojiCounts: Record<string, number>): number {
  let total = 0;
  for (const [emoji, count] of Object.entries(emojiCounts)) {
    if (!HEART_EMOJIS.has(emoji)) {
      continue;
    }

    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    total += Math.max(0, Math.floor(value));
  }

  return total;
}

export function normalizeTelegramUpdates(
  payload: unknown,
  trackedEmojis: string[] = ["❤️"],
): TelegramWebhookNormalized[] {
  const updates = extractTelegramUpdates(payload);
  const emojiSet = new Set(trackedEmojis.map((item) => item.trim()).filter(Boolean));

  return updates.map((item) => {
    const messageReaction = item.message_reaction;
    const messageReactionCount = item.message_reaction_count;
    const emojiCounts = !emojiSet.size
      ? {}
      : messageReactionCount
        ? normalizeTrackedCounts(messageReactionCount.reactions, emojiSet)
        : normalizeTrackedReactions(messageReaction?.new_reaction, emojiSet);
    return {
      updateId: Number.isFinite(Number(item.update_id)) ? Number(item.update_id) : null,
      chatId:
        (messageReactionCount?.chat?.id ?? messageReaction?.chat?.id) !== undefined
          ? String(messageReactionCount?.chat?.id ?? messageReaction?.chat?.id).trim() || null
          : null,
      messageId:
        Number.isFinite(Number(messageReactionCount?.message_id ?? messageReaction?.message_id))
          ? Number(messageReactionCount?.message_id ?? messageReaction?.message_id)
          : null,
      heartCount: normalizeHeartCount(emojiCounts),
      emojiCounts,
    };
  });
}
