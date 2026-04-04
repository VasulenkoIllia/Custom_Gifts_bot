import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../observability/logger";

type CreateStorageRetentionServiceParams = {
  logger: Logger;
  outputDir: string;
  tempDir: string;
  outputRetentionHours: number;
  tempRetentionHours: number;
  cleanupIntervalMs: number;
};

async function removeStaleChildren(params: {
  rootDir: string;
  maxAgeMs: number;
  logger: Logger;
  storageType: "output" | "temp";
}): Promise<{ removed: number; failed: number }> {
  const result = {
    removed: 0,
    failed: 0,
  };

  if (!isSafeCleanupRoot(params.rootDir)) {
    params.logger.error("storage_cleanup_blocked_unsafe_root", {
      storageType: params.storageType,
      rootDir: params.rootDir,
    });
    return result;
  }

  if (!fs.existsSync(params.rootDir)) {
    return result;
  }

  const entries = await fsp.readdir(params.rootDir, {
    withFileTypes: true,
  });
  const now = Date.now();

  for (const entry of entries) {
    const fullPath = path.join(params.rootDir, entry.name);
    try {
      const stats = await fsp.stat(fullPath);
      const ageMs = now - stats.mtimeMs;
      if (!Number.isFinite(ageMs) || ageMs < params.maxAgeMs) {
        continue;
      }

      await fsp.rm(fullPath, {
        recursive: true,
        force: true,
      });
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      params.logger.warn("storage_cleanup_failed", {
        storageType: params.storageType,
        path: fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export class StorageRetentionService {
  private readonly logger: Logger;
  private readonly outputDir: string;
  private readonly tempDir: string;
  private readonly outputRetentionHours: number;
  private readonly tempRetentionHours: number;
  private readonly cleanupIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(params: CreateStorageRetentionServiceParams) {
    this.logger = params.logger;
    this.outputDir = path.resolve(params.outputDir);
    this.tempDir = path.resolve(params.tempDir);
    this.outputRetentionHours = Math.max(1, Math.floor(params.outputRetentionHours));
    this.tempRetentionHours = Math.max(1, Math.floor(params.tempRetentionHours));
    this.cleanupIntervalMs = Math.max(60_000, Math.floor(params.cleanupIntervalMs));
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.cleanupIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }

    this.runPromise = this.runCleanup().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async runCleanup(): Promise<void> {
    const outputResult = await removeStaleChildren({
      rootDir: this.outputDir,
      maxAgeMs: this.outputRetentionHours * 60 * 60 * 1000,
      logger: this.logger,
      storageType: "output",
    });

    const tempResult = await removeStaleChildren({
      rootDir: this.tempDir,
      maxAgeMs: this.tempRetentionHours * 60 * 60 * 1000,
      logger: this.logger,
      storageType: "temp",
    });

    this.logger.info("storage_cleanup_completed", {
      outputDir: this.outputDir,
      tempDir: this.tempDir,
      outputRemoved: outputResult.removed,
      outputFailed: outputResult.failed,
      tempRemoved: tempResult.removed,
      tempFailed: tempResult.failed,
      outputRetentionHours: this.outputRetentionHours,
      tempRetentionHours: this.tempRetentionHours,
    });
  }
}

function isSafeCleanupRoot(rootDir: string): boolean {
  const resolved = path.resolve(rootDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return false;
  }

  const segments = resolved.split(path.sep).filter(Boolean);
  return segments.length >= 2;
}
