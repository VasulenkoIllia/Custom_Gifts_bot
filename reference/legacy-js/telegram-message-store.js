"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

class TelegramMessageOrderStore {
  constructor({ filePath, maxEntries = 25_000 } = {}) {
    this.filePath = path.resolve(String(filePath ?? "outputs/telegram-message-map.json"));
    this.maxEntries = Number.isFinite(Number(maxEntries))
      ? Math.max(100, Math.floor(Number(maxEntries)))
      : 25_000;
    this.entries = new Map();
    this.lock = Promise.resolve();
    this.initPromise = null;
    this.lastLoadedMtimeMs = 0;
  }

  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.#load();
    return this.initPromise;
  }

  async #load() {
    const dirPath = path.dirname(this.filePath);
    await fsp.mkdir(dirPath, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.entries.clear();
      this.lastLoadedMtimeMs = 0;
      return;
    }

    const fileStats = await fsp.stat(this.filePath);
    const raw = await fsp.readFile(this.filePath, "utf8");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      payload = null;
    }

    const sourceEntries = Array.isArray(payload?.entries) ? payload.entries : [];
    this.entries.clear();
    for (const item of sourceEntries) {
      const chatId = String(item?.chat_id ?? "").trim();
      const messageId = Number.parseInt(String(item?.message_id ?? ""), 10);
      if (!chatId || !Number.isFinite(messageId)) {
        continue;
      }

      const key = this.#buildKey(chatId, messageId);
      this.entries.set(key, {
        key,
        order_id: String(item?.order_id ?? "").trim(),
        chat_id: chatId,
        message_id: messageId,
        created_at: String(item?.created_at ?? new Date().toISOString()),
        updated_at: String(item?.updated_at ?? new Date().toISOString()),
        reaction_applied: Boolean(item?.reaction_applied),
        reaction_applied_at: item?.reaction_applied_at ?? null,
        reaction_applied_status_id: Number.isFinite(Number(item?.reaction_applied_status_id))
          ? Number(item.reaction_applied_status_id)
          : null,
        last_heart_count: Number.isFinite(Number(item?.last_heart_count))
          ? Number(item.last_heart_count)
          : 0,
        last_heart_emoji: item?.last_heart_emoji ?? null,
        reaction_user_states:
          item?.reaction_user_states && typeof item.reaction_user_states === "object"
            ? { ...item.reaction_user_states }
            : {},
      });
    }

    this.lastLoadedMtimeMs = Number.isFinite(fileStats?.mtimeMs) ? fileStats.mtimeMs : Date.now();
  }

  async #refreshIfExternalChanged() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const stats = await fsp.stat(this.filePath);
    const mtimeMs = Number.isFinite(stats?.mtimeMs) ? stats.mtimeMs : 0;
    if (mtimeMs <= this.lastLoadedMtimeMs) {
      return;
    }

    await this.#load();
  }

  async linkMessages({ orderId, chatId, messageIds }) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedOrderId = String(orderId ?? "").trim();
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageIds = Array.isArray(messageIds)
      ? messageIds
          .map((value) => Number.parseInt(String(value), 10))
          .filter((value) => Number.isFinite(value))
      : [];

    if (!normalizedOrderId || !normalizedChatId || normalizedMessageIds.length === 0) {
      return {
        linked: 0,
      };
    }

    await this.#withLock(async () => {
      const now = new Date().toISOString();
      for (const messageId of normalizedMessageIds) {
        const key = this.#buildKey(normalizedChatId, messageId);
        const current = this.entries.get(key);
        this.entries.set(key, {
          key,
          order_id: normalizedOrderId,
          chat_id: normalizedChatId,
          message_id: messageId,
          created_at: current?.created_at ?? now,
          updated_at: now,
          reaction_applied: Boolean(current?.reaction_applied),
          reaction_applied_at: current?.reaction_applied_at ?? null,
          reaction_applied_status_id: current?.reaction_applied_status_id ?? null,
          last_heart_count: Number.isFinite(Number(current?.last_heart_count))
            ? Number(current.last_heart_count)
            : 0,
          last_heart_emoji: current?.last_heart_emoji ?? null,
          reaction_user_states:
            current?.reaction_user_states && typeof current.reaction_user_states === "object"
              ? { ...current.reaction_user_states }
              : {},
        });
      }

      this.#trimToLimit();
      await this.#persist();
    });

    return {
      linked: normalizedMessageIds.length,
    };
  }

  async getMessage(chatId, messageId) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);

    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return null;
    }

    const key = this.#buildKey(normalizedChatId, normalizedMessageId);
    const entry = this.entries.get(key);
    return entry ? { ...entry } : null;
  }

  async listByOrder(orderId, { limit = 100 } = {}) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      return [];
    }

    const result = [];
    for (const entry of this.entries.values()) {
      if (entry.order_id !== normalizedOrderId) {
        continue;
      }
      result.push({ ...entry });
    }

    result.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    return result.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  async markReactionState(
    chatId,
    messageId,
    {
      lastHeartCount = null,
      lastHeartEmoji = null,
      reactionApplied = null,
      reactionAppliedStatusId = null,
    } = {},
  ) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return null;
    }

    let updatedEntry = null;
    await this.#withLock(async () => {
      const key = this.#buildKey(normalizedChatId, normalizedMessageId);
      const current = this.entries.get(key);
      if (!current) {
        return;
      }

      const now = new Date().toISOString();
      updatedEntry = {
        ...current,
        updated_at: now,
        last_heart_count:
          lastHeartCount === null ? current.last_heart_count : Number(lastHeartCount) || 0,
        last_heart_emoji: lastHeartEmoji === null ? current.last_heart_emoji : String(lastHeartEmoji),
        reaction_applied:
          reactionApplied === null ? current.reaction_applied : Boolean(reactionApplied),
        reaction_applied_at:
          reactionApplied === true
            ? current.reaction_applied_at ?? now
            : reactionApplied === false
              ? null
              : current.reaction_applied_at,
        reaction_applied_status_id:
          reactionAppliedStatusId === null
            ? current.reaction_applied_status_id
            : Number.isFinite(Number(reactionAppliedStatusId))
              ? Number(reactionAppliedStatusId)
              : current.reaction_applied_status_id,
        reaction_user_states:
          current?.reaction_user_states && typeof current.reaction_user_states === "object"
            ? { ...current.reaction_user_states }
            : {},
      };

      this.entries.set(key, updatedEntry);
      await this.#persist();
    });

    return updatedEntry ? { ...updatedEntry } : null;
  }

  async upsertUserHeartReaction(chatId, messageId, { userKey, hasHeart, emoji } = {}) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    const normalizedUserKey = String(userKey ?? "").trim();
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId) || !normalizedUserKey) {
      return null;
    }

    let updatedEntry = null;
    await this.#withLock(async () => {
      const key = this.#buildKey(normalizedChatId, normalizedMessageId);
      const current = this.entries.get(key);
      if (!current) {
        return;
      }

      const currentStates =
        current.reaction_user_states && typeof current.reaction_user_states === "object"
          ? { ...current.reaction_user_states }
          : {};

      if (hasHeart) {
        currentStates[normalizedUserKey] = true;
      } else {
        delete currentStates[normalizedUserKey];
      }

      const heartCount = Object.keys(currentStates).length;
      const now = new Date().toISOString();
      updatedEntry = {
        ...current,
        updated_at: now,
        last_heart_count: heartCount,
        last_heart_emoji: emoji ? String(emoji) : current.last_heart_emoji,
        reaction_user_states: currentStates,
      };

      this.entries.set(key, updatedEntry);
      await this.#persist();
    });

    return updatedEntry ? { ...updatedEntry } : null;
  }

  async resetReactionState({ orderId = null, chatId = null, messageId = null } = {}) {
    await this.init();
    await this.#refreshIfExternalChanged();

    const normalizedOrderId = orderId === null ? null : String(orderId).trim();
    const normalizedChatId = chatId === null ? null : String(chatId).trim();
    const normalizedMessageId =
      messageId === null ? null : Number.parseInt(String(messageId), 10);

    if (
      !normalizedOrderId &&
      !normalizedChatId &&
      !Number.isFinite(normalizedMessageId)
    ) {
      return {
        updated: 0,
      };
    }

    let updated = 0;
    await this.#withLock(async () => {
      for (const [key, entry] of this.entries.entries()) {
        const matchesOrder = normalizedOrderId ? entry.order_id === normalizedOrderId : true;
        const matchesChat = normalizedChatId ? entry.chat_id === normalizedChatId : true;
        const matchesMessage = Number.isFinite(normalizedMessageId)
          ? entry.message_id === normalizedMessageId
          : true;

        if (!matchesOrder || !matchesChat || !matchesMessage) {
          continue;
        }

        this.entries.set(key, {
          ...entry,
          updated_at: new Date().toISOString(),
          reaction_applied: false,
          reaction_applied_at: null,
          reaction_applied_status_id: null,
          last_heart_count: 0,
          reaction_user_states: {},
        });
        updated += 1;
      }

      if (updated > 0) {
        await this.#persist();
      }
    });

    return {
      updated,
    };
  }

  #buildKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
  }

  async #withLock(task) {
    const run = this.lock.then(task);
    this.lock = run.catch(() => {});
    return run;
  }

  #trimToLimit() {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const records = Array.from(this.entries.values());
    records.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    const keep = records.slice(0, this.maxEntries);
    this.entries.clear();
    for (const record of keep) {
      this.entries.set(record.key, record);
    }
  }

  async #persist() {
    const payload = {
      version: 1,
      generated_at: new Date().toISOString(),
      entries: Array.from(this.entries.values()).map((entry) => ({
        order_id: entry.order_id,
        chat_id: entry.chat_id,
        message_id: entry.message_id,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        reaction_applied: entry.reaction_applied,
        reaction_applied_at: entry.reaction_applied_at,
        reaction_applied_status_id: entry.reaction_applied_status_id,
        last_heart_count: entry.last_heart_count,
        last_heart_emoji: entry.last_heart_emoji,
        reaction_user_states:
          entry.reaction_user_states && typeof entry.reaction_user_states === "object"
            ? entry.reaction_user_states
            : {},
      })),
    };

    const tempPath = `${this.filePath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fsp.rename(tempPath, this.filePath);
    const stats = await fsp.stat(this.filePath);
    this.lastLoadedMtimeMs = Number.isFinite(stats?.mtimeMs) ? stats.mtimeMs : Date.now();
  }
}

module.exports = {
  TelegramMessageOrderStore,
};
