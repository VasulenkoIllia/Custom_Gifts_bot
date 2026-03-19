import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type IdempotencyEntry = {
  key: string;
  createdAt: string;
};

export type IdempotencyReserveResult = {
  created: boolean;
  entry: IdempotencyEntry;
};

type IdempotencyStorePayload = {
  entries: IdempotencyEntry[];
};

export class FileIdempotencyStore {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, IdempotencyEntry>();
  private initPromise: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxEntries = 50_000) {
    this.filePath = path.resolve(filePath);
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(1000, Math.floor(maxEntries)) : 50_000;
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.load();
    return this.initPromise;
  }

  async reserve(key: string): Promise<IdempotencyReserveResult> {
    await this.init();

    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) {
      throw new Error("Idempotency key is required.");
    }

    let result: IdempotencyReserveResult = {
      created: false,
      entry: {
        key: normalizedKey,
        createdAt: new Date().toISOString(),
      },
    };

    await this.withLock(async () => {
      const existing = this.entries.get(normalizedKey);
      if (existing) {
        result = { created: false, entry: existing };
        return;
      }

      const entry: IdempotencyEntry = {
        key: normalizedKey,
        createdAt: new Date().toISOString(),
      };

      this.entries.set(normalizedKey, entry);
      this.trimIfNeeded();
      await this.persist();
      result = {
        created: true,
        entry,
      };
    });

    return result;
  }

  async size(): Promise<number> {
    await this.init();
    return this.entries.size;
  }

  async remove(key: string): Promise<boolean> {
    await this.init();
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) {
      return false;
    }

    let removed = false;
    await this.withLock(async () => {
      removed = this.entries.delete(normalizedKey);
      if (removed) {
        await this.persist();
      }
    });

    return removed;
  }

  private async load(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.entries.clear();
      return;
    }

    const content = await fsp.readFile(this.filePath, "utf8");
    let payload: IdempotencyStorePayload | null = null;

    try {
      payload = content ? (JSON.parse(content) as IdempotencyStorePayload) : null;
    } catch (_error) {
      payload = null;
    }

    this.entries.clear();
    const list = Array.isArray(payload?.entries) ? payload.entries : [];
    for (const item of list) {
      const normalizedKey = String(item?.key ?? "").trim();
      if (!normalizedKey) {
        continue;
      }
      this.entries.set(normalizedKey, {
        key: normalizedKey,
        createdAt: String(item?.createdAt ?? new Date().toISOString()),
      });
    }

    this.trimIfNeeded();
  }

  private async persist(): Promise<void> {
    const payload: IdempotencyStorePayload = {
      entries: Array.from(this.entries.values()),
    };

    const tempPath = `${this.filePath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fsp.rename(tempPath, this.filePath);
  }

  private trimIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const sorted = Array.from(this.entries.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );

    const removeCount = this.entries.size - this.maxEntries;
    for (let index = 0; index < removeCount; index += 1) {
      const item = sorted[index];
      if (item) {
        this.entries.delete(item.key);
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
