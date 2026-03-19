import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type TelegramMessageMapEntry = {
  key: string;
  orderId: string;
  chatId: string;
  messageId: number;
  createdAt: string;
  updatedAt: string;
  lastHeartCount: number;
};

export type TelegramOrderWorkflowState = {
  orderId: string;
  highestStageIndex: number;
  appliedStatusId: number | null;
  updatedAt: string;
  lastHeartCount: number;
};

type TelegramMessageMapPayload = {
  messages: TelegramMessageMapEntry[];
  orderStates: TelegramOrderWorkflowState[];
};

export class TelegramMessageMapStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private readonly messages = new Map<string, TelegramMessageMapEntry>();
  private readonly orderStates = new Map<string, TelegramOrderWorkflowState>();
  private initPromise: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxMessages = 50_000) {
    this.filePath = path.resolve(filePath);
    this.maxMessages = Number.isFinite(maxMessages)
      ? Math.max(1_000, Math.floor(maxMessages))
      : 50_000;
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.load();
    return this.initPromise;
  }

  async linkMessages(params: {
    orderId: string;
    chatId: string;
    messageIds: number[];
  }): Promise<{ linked: number }> {
    await this.init();

    const orderId = String(params.orderId ?? "").trim();
    const chatId = String(params.chatId ?? "").trim();
    const messageIds = Array.isArray(params.messageIds)
      ? params.messageIds
          .map((item) => Number.parseInt(String(item), 10))
          .filter((item) => Number.isFinite(item))
      : [];

    if (!orderId || !chatId || messageIds.length === 0) {
      return { linked: 0 };
    }

    await this.withLock(async () => {
      const now = new Date().toISOString();
      for (const messageId of messageIds) {
        const key = this.buildKey(chatId, messageId);
        const existing = this.messages.get(key);
        this.messages.set(key, {
          key,
          orderId,
          chatId,
          messageId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastHeartCount: existing?.lastHeartCount ?? 0,
        });
      }

      this.trimMessagesIfNeeded();
      await this.persist();
    });

    return {
      linked: messageIds.length,
    };
  }

  async getOrderIdByMessage(chatId: string, messageId: number): Promise<string | null> {
    await this.init();

    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return null;
    }

    const key = this.buildKey(normalizedChatId, normalizedMessageId);
    return this.messages.get(key)?.orderId ?? null;
  }

  async markMessageHeartCount(chatId: string, messageId: number, heartCount: number): Promise<void> {
    await this.init();

    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    const normalizedHeartCount = Number.isFinite(heartCount)
      ? Math.max(0, Math.floor(heartCount))
      : 0;
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return;
    }

    await this.withLock(async () => {
      const key = this.buildKey(normalizedChatId, normalizedMessageId);
      const entry = this.messages.get(key);
      if (!entry) {
        return;
      }

      this.messages.set(key, {
        ...entry,
        updatedAt: new Date().toISOString(),
        lastHeartCount: normalizedHeartCount,
      });
      await this.persist();
    });
  }

  async getOrderState(orderId: string): Promise<TelegramOrderWorkflowState | null> {
    await this.init();
    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      return null;
    }

    const state = this.orderStates.get(normalizedOrderId);
    return state ? { ...state } : null;
  }

  async upsertOrderState(params: {
    orderId: string;
    highestStageIndex: number;
    appliedStatusId: number;
    lastHeartCount: number;
  }): Promise<TelegramOrderWorkflowState> {
    await this.init();

    const orderId = String(params.orderId ?? "").trim();
    if (!orderId) {
      throw new Error("orderId is required.");
    }

    const highestStageIndex = Number.isFinite(params.highestStageIndex)
      ? Math.max(-1, Math.floor(params.highestStageIndex))
      : -1;
    const appliedStatusId = Number.isFinite(params.appliedStatusId)
      ? Math.max(1, Math.floor(params.appliedStatusId))
      : null;
    const lastHeartCount = Number.isFinite(params.lastHeartCount)
      ? Math.max(0, Math.floor(params.lastHeartCount))
      : 0;

    let result: TelegramOrderWorkflowState = {
      orderId,
      highestStageIndex,
      appliedStatusId,
      updatedAt: new Date().toISOString(),
      lastHeartCount,
    };

    await this.withLock(async () => {
      const now = new Date().toISOString();
      const current = this.orderStates.get(orderId);
      result = {
        orderId,
        highestStageIndex,
        appliedStatusId,
        updatedAt: now,
        lastHeartCount,
      };

      this.orderStates.set(orderId, {
        ...current,
        ...result,
      });

      await this.persist();
    });

    return { ...result };
  }

  private buildKey(chatId: string, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private async load(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.messages.clear();
      this.orderStates.clear();
      return;
    }

    const raw = await fsp.readFile(this.filePath, "utf8");
    let payload: TelegramMessageMapPayload | null = null;
    try {
      payload = raw ? (JSON.parse(raw) as TelegramMessageMapPayload) : null;
    } catch (_error) {
      payload = null;
    }

    this.messages.clear();
    this.orderStates.clear();

    const messageList = Array.isArray(payload?.messages) ? payload.messages : [];
    for (const item of messageList) {
      const chatId = String(item?.chatId ?? "").trim();
      const orderId = String(item?.orderId ?? "").trim();
      const messageId = Number.parseInt(String(item?.messageId ?? ""), 10);
      if (!chatId || !orderId || !Number.isFinite(messageId)) {
        continue;
      }

      const key = this.buildKey(chatId, messageId);
      this.messages.set(key, {
        key,
        orderId,
        chatId,
        messageId,
        createdAt: String(item?.createdAt ?? new Date().toISOString()),
        updatedAt: String(item?.updatedAt ?? new Date().toISOString()),
        lastHeartCount: Number.isFinite(item?.lastHeartCount)
          ? Math.max(0, Math.floor(item.lastHeartCount))
          : 0,
      });
    }

    const stateList = Array.isArray(payload?.orderStates) ? payload.orderStates : [];
    for (const item of stateList) {
      const orderId = String(item?.orderId ?? "").trim();
      const highestStageIndex = Number.parseInt(String(item?.highestStageIndex ?? ""), 10);
      if (!orderId || !Number.isFinite(highestStageIndex)) {
        continue;
      }

      this.orderStates.set(orderId, {
        orderId,
        highestStageIndex,
        appliedStatusId: Number.isFinite(Number(item?.appliedStatusId))
          ? Math.max(1, Math.floor(Number(item?.appliedStatusId)))
          : null,
        updatedAt: String(item?.updatedAt ?? new Date().toISOString()),
        lastHeartCount: Number.isFinite(item?.lastHeartCount)
          ? Math.max(0, Math.floor(item.lastHeartCount))
          : 0,
      });
    }
  }

  private async persist(): Promise<void> {
    const payload: TelegramMessageMapPayload = {
      messages: Array.from(this.messages.values()).map((item) => ({ ...item })),
      orderStates: Array.from(this.orderStates.values()).map((item) => ({ ...item })),
    };

    const tempPath = `${this.filePath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fsp.rename(tempPath, this.filePath);
  }

  private trimMessagesIfNeeded(): void {
    if (this.messages.size <= this.maxMessages) {
      return;
    }

    const sorted = Array.from(this.messages.values()).sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
    const removeCount = this.messages.size - this.maxMessages;

    for (let index = 0; index < removeCount; index += 1) {
      const item = sorted[index];
      if (item) {
        this.messages.delete(item.key);
      }
    }
  }

  private async withLock<T>(handler: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => undefined;

    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await handler();
    } finally {
      release();
    }
  }
}
