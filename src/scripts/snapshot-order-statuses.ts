import fs from "node:fs/promises";
import path from "node:path";
import { createCrmClientFromConfig, loadValidatedConfigFromEnv } from "./script-runtime-utils";
import {
  DEFAULT_TEST_SET_PATH,
  ensureParentDir,
  loadOrderIdsFromTestSet,
  normalizeOrderIds,
  timestampForFilename,
} from "./script-utils";

type SnapshotEntry = {
  orderId: string;
  statusId: number | null;
  sourceId: number | null;
  sourceUuid: string | null;
  capturedAt: string;
};

type OrderStatusSnapshot = {
  createdAt: string;
  orderIds: string[];
  entries: SnapshotEntry[];
};

type ParsedArgs = {
  orderIds: string[];
  testSetPath: string;
  outputPath: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  const orderIdArgs: string[] = [];
  let testSetPath = DEFAULT_TEST_SET_PATH;
  let outputPath: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--order-ids=")) {
      orderIdArgs.push(arg.slice("--order-ids=".length));
      continue;
    }

    if (arg.startsWith("--test-set=")) {
      testSetPath = path.resolve(process.cwd(), arg.slice("--test-set=".length));
      continue;
    }

    if (arg.startsWith("--output=")) {
      outputPath = path.resolve(process.cwd(), arg.slice("--output=".length));
      continue;
    }

    orderIdArgs.push(arg);
  }

  return {
    orderIds: normalizeOrderIds(orderIdArgs),
    testSetPath,
    outputPath,
  };
}

function asInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const orderIds =
    args.orderIds.length > 0 ? args.orderIds : await loadOrderIdsFromTestSet(args.testSetPath);

  if (orderIds.length === 0) {
    throw new Error("No order ids provided. Pass --order-ids=... or configure the test set.");
  }

  const config = loadValidatedConfigFromEnv();
  const crmClient = createCrmClientFromConfig(config);

  const now = new Date();
  const createdAt = now.toISOString();
  const outputPath =
    args.outputPath ??
    path.resolve(
      process.cwd(),
      "artifacts/order-status-snapshots",
      `snapshot-${timestampForFilename(now)}.json`,
    );

  const entries: SnapshotEntry[] = [];
  for (const orderId of orderIds) {
    const order = await crmClient.getOrder(orderId);
    entries.push({
      orderId,
      statusId: asInteger(order.status_id),
      sourceId: asInteger(order.source_id),
      sourceUuid: String(order.source_uuid ?? "").trim() || null,
      capturedAt: createdAt,
    });
  }

  const snapshot: OrderStatusSnapshot = {
    createdAt,
    orderIds,
    entries,
  };

  await ensureParentDir(outputPath);
  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  process.stdout.write(`Snapshot saved: ${outputPath}\n`);
  for (const entry of entries) {
    process.stdout.write(
      `- order=${entry.orderId} status=${entry.statusId ?? "unknown"} source=${entry.sourceId ?? "unknown"}\n`,
    );
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
