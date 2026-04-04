import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/logger";

type TestOrderSet = {
  orderIds?: string[];
};

export const DEFAULT_TEST_SET_PATH = path.resolve(
  process.cwd(),
  "config/test-orders/business-logic-order-set.json",
);

export function createSilentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeOrderIds(values: string[]): string[] {
  const result: string[] = [];

  for (const value of values) {
    for (const part of value.split(",")) {
      const normalized = part.trim();
      if (/^\d+$/.test(normalized)) {
        result.push(normalized);
      }
    }
  }

  return Array.from(new Set(result));
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function loadOrderIdsFromTestSet(filePath = DEFAULT_TEST_SET_PATH): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as TestOrderSet;
  return Array.isArray(parsed.orderIds)
    ? parsed.orderIds.map(String).filter((item) => /^\d+$/.test(item))
    : [];
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function timestampForFilename(now = new Date()): string {
  const iso = now.toISOString().replace(/[:]/g, "-");
  return iso.replace(/\.\d{3}Z$/, "Z");
}
