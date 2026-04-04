import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import type { AppConfig } from "../../config/config.types";
import type { DatabaseClient } from "../db/postgres-client";
import type { QueueProducer } from "../queue/queue.types";
import type { OrderIntakeJobPayload, ReactionIntakeJobPayload } from "../queue/queue-jobs";

type HealthCheck = {
  ok: boolean;
  latencyMs: number;
  skipped?: boolean;
  details?: Record<string, unknown>;
  error?: string;
};

type RuntimeHealthParams = {
  config: AppConfig;
  db: DatabaseClient;
  orderQueue: QueueProducer<OrderIntakeJobPayload>;
  reactionQueue: QueueProducer<ReactionIntakeJobPayload>;
};

export class RuntimeHealthService {
  private readonly config: AppConfig;
  private readonly db: DatabaseClient;
  private readonly orderQueue: QueueProducer<OrderIntakeJobPayload>;
  private readonly reactionQueue: QueueProducer<ReactionIntakeJobPayload>;

  constructor(params: RuntimeHealthParams) {
    this.config = params.config;
    this.db = params.db;
    this.orderQueue = params.orderQueue;
    this.reactionQueue = params.reactionQueue;
  }

  getLiveness(): Record<string, unknown> {
    return {
      ok: true,
      role: this.config.appRole,
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
    };
  }

  async getReadiness(): Promise<Record<string, unknown>> {
    const checks = await this.collectChecks();
    const ok = checks.db.ok && checks.storage.ok && checks.disk.ok && checks.pdf.ok;

    return {
      ok,
      role: this.config.appRole,
      checks,
    };
  }

  async getHealthSummary(): Promise<Record<string, unknown>> {
    const [readiness, orderQueueStats, reactionQueueStats] = await Promise.all([
      this.getReadiness(),
      this.orderQueue.getStats(),
      this.reactionQueue.getStats(),
    ]);

    return {
      ...readiness,
      service: "custom-gifts-bot",
      phase: this.config.projectPhase,
      ts_bootstrap: true,
      queue: {
        order: orderQueueStats,
        reaction: reactionQueueStats,
      },
    };
  }

  private async collectChecks(): Promise<{
    db: HealthCheck;
    storage: HealthCheck;
    disk: HealthCheck;
    pdf: HealthCheck;
  }> {
    const [db, storage, disk, pdf] = await Promise.all([
      this.measureCheck(() => this.checkDatabase()),
      this.measureCheck(() => this.checkStorage()),
      this.measureCheck(() => this.checkDisk()),
      this.measureCheck(() => this.checkPdfDependency()),
    ]);

    return {
      db,
      storage,
      disk,
      pdf,
    };
  }

  private async measureCheck(
    probe: () => Promise<Omit<HealthCheck, "latencyMs">>,
  ): Promise<HealthCheck> {
    const startedAt = Date.now();

    try {
      const result = await withTimeout(probe(), this.config.readinessProbeTimeoutMs, "timeout");
      return {
        latencyMs: Date.now() - startedAt,
        ...result,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkDatabase(): Promise<Omit<HealthCheck, "latencyMs">> {
    await this.db.query("SELECT 1 AS ok");
    return {
      ok: true,
    };
  }

  private async checkStorage(): Promise<Omit<HealthCheck, "latencyMs">> {
    if (!requiresPdfReadiness(this.config.appRole)) {
      return {
        ok: true,
        skipped: true,
        details: {
          reason: "pdf_worker_not_enabled",
        },
      };
    }

    const paths = [this.config.outputDir, this.config.tempDir];
    for (const currentPath of paths) {
      if (!fs.existsSync(currentPath)) {
        throw new Error(`Path does not exist: ${currentPath}`);
      }

      await fsp.access(currentPath, fs.constants.R_OK | fs.constants.W_OK);
    }

    return {
      ok: true,
      details: {
        paths,
      },
    };
  }

  private async checkDisk(): Promise<Omit<HealthCheck, "latencyMs">> {
    if (!requiresPdfReadiness(this.config.appRole)) {
      return {
        ok: true,
        skipped: true,
        details: {
          reason: "pdf_worker_not_enabled",
        },
      };
    }

    if (this.config.readinessMinDiskFreeBytes === 0) {
      return {
        ok: true,
        skipped: true,
        details: {
          reason: "disk_threshold_disabled",
        },
      };
    }

    const outputDisk = await this.readFreeBytes(this.config.outputDir);
    const tempDisk = await this.readFreeBytes(this.config.tempDir);
    const minimum = this.config.readinessMinDiskFreeBytes;
    const ok = outputDisk.availableBytes >= minimum && tempDisk.availableBytes >= minimum;

    if (!ok) {
      throw new Error(
        `Insufficient disk space. output=${outputDisk.availableBytes} temp=${tempDisk.availableBytes} minimum=${minimum}`,
      );
    }

    return {
      ok: true,
      details: {
        minimumBytes: minimum,
        outputAvailableBytes: outputDisk.availableBytes,
        tempAvailableBytes: tempDisk.availableBytes,
      },
    };
  }

  private async checkPdfDependency(): Promise<Omit<HealthCheck, "latencyMs">> {
    if (!requiresPdfReadiness(this.config.appRole)) {
      return {
        ok: true,
        skipped: true,
        details: {
          reason: "pdf_worker_not_enabled",
        },
      };
    }

    const version = await probeGhostscript(this.config.readinessProbeTimeoutMs);
    return {
      ok: true,
      details: {
        command: "gs",
        version,
      },
    };
  }

  private async readFreeBytes(targetPath: string): Promise<{ availableBytes: number }> {
    const stats = await fsp.statfs(targetPath);
    return {
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  }
}

function requiresPdfReadiness(role: AppConfig["appRole"]): boolean {
  return role === "all" || role === "workers" || role === "order_worker";
}

async function probeGhostscript(timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("gs", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Ghostscript readiness probe timed out."));
    }, Math.max(1_000, timeoutMs));

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(new Error(`Ghostscript probe failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const details = `${stdout}\n${stderr}`.trim();
        reject(
          new Error(
            `Ghostscript probe exited with code ${code}${details ? `: ${details.slice(0, 300)}` : ""}`,
          ),
        );
        return;
      }

      resolve(stdout.trim() || "unknown");
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} after ${timeoutMs}ms`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
