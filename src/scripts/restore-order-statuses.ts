import fs from "node:fs/promises";
import path from "node:path";
import { createCrmClientFromConfig, loadValidatedConfigFromEnv } from "./script-runtime-utils";

type SnapshotEntry = {
  orderId: string;
  statusId: number | null;
};

type OrderStatusSnapshot = {
  createdAt?: string;
  orderIds?: string[];
  entries?: SnapshotEntry[];
};

type ParsedArgs = {
  snapshotPath: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  let snapshotPath = "";

  for (const arg of argv) {
    if (arg.startsWith("--snapshot=")) {
      snapshotPath = path.resolve(process.cwd(), arg.slice("--snapshot=".length));
    }
  }

  return {
    snapshotPath,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshotPath) {
    throw new Error("Snapshot path is required. Use --snapshot=artifacts/order-status-snapshots/....json");
  }

  const raw = await fs.readFile(args.snapshotPath, "utf8");
  const snapshot = JSON.parse(raw) as OrderStatusSnapshot;
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];

  if (entries.length === 0) {
    throw new Error("Snapshot file does not contain any entries.");
  }

  const config = loadValidatedConfigFromEnv();
  const crmClient = createCrmClientFromConfig(config);

  for (const entry of entries) {
    const orderId = String(entry.orderId ?? "").trim();
    const statusId = Number.parseInt(String(entry.statusId ?? ""), 10);
    if (!orderId || !Number.isFinite(statusId) || statusId <= 0) {
      process.stdout.write(`skip order=${orderId || "unknown"} invalid snapshot status\n`);
      continue;
    }

    const before = await crmClient.getOrder(orderId);
    const beforeStatusId = Number.parseInt(String(before.status_id ?? ""), 10);

    if (beforeStatusId === statusId) {
      process.stdout.write(`order=${orderId} already=${statusId}\n`);
      continue;
    }

    const updated = await crmClient.updateOrderStatus(orderId, statusId);
    const afterStatusId = Number.parseInt(String(updated.status_id ?? ""), 10);
    process.stdout.write(
      `order=${orderId} restored_from=${Number.isFinite(beforeStatusId) ? beforeStatusId : "unknown"} restored_to=${Number.isFinite(afterStatusId) ? afterStatusId : "unknown"}\n`,
    );
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
