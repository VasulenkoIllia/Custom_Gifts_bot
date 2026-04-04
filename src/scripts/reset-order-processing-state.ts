import path from "node:path";
import { PostgresClient } from "../modules/db/postgres-client";
import { DEFAULT_TEST_SET_PATH, loadOrderIdsFromTestSet, normalizeOrderIds } from "./script-utils";

type ParsedArgs = {
  orderIds: string[];
  testSetPath: string;
  includeHistory: boolean;
};

type ResetCounters = {
  telegramMessageMap: number;
  orderWorkflowState: number;
  forwardingEvents: number;
  forwardingBatches: number;
  telegramDeliveryRecords: number;
  queueJobs: number;
  deadLetters: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const orderIdArgs: string[] = [];
  let testSetPath = DEFAULT_TEST_SET_PATH;
  let includeHistory = false;

  for (const arg of argv) {
    if (arg.startsWith("--order-ids=")) {
      orderIdArgs.push(arg.slice("--order-ids=".length));
      continue;
    }

    if (arg.startsWith("--test-set=")) {
      testSetPath = path.resolve(process.cwd(), arg.slice("--test-set=".length));
      continue;
    }

    if (arg === "--include-history") {
      includeHistory = true;
      continue;
    }

    orderIdArgs.push(arg);
  }

  return {
    orderIds: normalizeOrderIds(orderIdArgs),
    testSetPath,
    includeHistory,
  };
}

function readDatabaseUrl(): string {
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  return databaseUrl;
}

function readDatabasePoolMax(): number {
  const parsed = Number.parseInt(String(process.env.DATABASE_POOL_MAX ?? "5"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5;
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const orderIds =
    args.orderIds.length > 0 ? args.orderIds : await loadOrderIdsFromTestSet(args.testSetPath);

  if (orderIds.length === 0) {
    throw new Error("No order ids provided. Pass --order-ids=... or configure the test set.");
  }

  const client = new PostgresClient({
    connectionString: readDatabaseUrl(),
    maxPoolSize: readDatabasePoolMax(),
  });

  try {
    const counters = await client.withTransaction<ResetCounters>(async (tx) => {
      const telegramMessageMap = await tx.query(
        `
          DELETE FROM telegram_message_map
          WHERE order_id = ANY($1::text[])
        `,
        [orderIds],
      );
      const orderWorkflowState = await tx.query(
        `
          DELETE FROM order_workflow_state
          WHERE order_id = ANY($1::text[])
        `,
        [orderIds],
      );
      const forwardingEvents = await tx.query(
        `
          DELETE FROM forwarding_events
          WHERE order_id = ANY($1::text[])
        `,
        [orderIds],
      );
      const forwardingBatches = await tx.query(
        `
          DELETE FROM forwarding_batches
          WHERE order_id = ANY($1::text[])
        `,
        [orderIds],
      );
      const telegramDeliveryRecords = await tx.query(
        `
          DELETE FROM telegram_delivery_records
          WHERE order_id = ANY($1::text[])
        `,
        [orderIds],
      );

      const queueJobs = args.includeHistory
        ? await tx.query(
            `
              DELETE FROM queue_jobs
              WHERE payload->>'orderId' = ANY($1::text[])
            `,
            [orderIds],
          )
        : { rowCount: 0 };
      const deadLetters = args.includeHistory
        ? await tx.query(
            `
              DELETE FROM dead_letters
              WHERE payload->>'orderId' = ANY($1::text[])
            `,
            [orderIds],
          )
        : { rowCount: 0 };

      return {
        telegramMessageMap: telegramMessageMap.rowCount,
        orderWorkflowState: orderWorkflowState.rowCount,
        forwardingEvents: forwardingEvents.rowCount,
        forwardingBatches: forwardingBatches.rowCount,
        telegramDeliveryRecords: telegramDeliveryRecords.rowCount,
        queueJobs: queueJobs.rowCount,
        deadLetters: deadLetters.rowCount,
      };
    });

    process.stdout.write(`Reset completed for ${orderIds.length} order(s): ${orderIds.join(", ")}\n`);
    process.stdout.write(`- telegram_message_map: ${counters.telegramMessageMap}\n`);
    process.stdout.write(`- order_workflow_state: ${counters.orderWorkflowState}\n`);
    process.stdout.write(`- forwarding_events: ${counters.forwardingEvents}\n`);
    process.stdout.write(`- forwarding_batches: ${counters.forwardingBatches}\n`);
    process.stdout.write(`- telegram_delivery_records: ${counters.telegramDeliveryRecords}\n`);
    if (args.includeHistory) {
      process.stdout.write(`- queue_jobs: ${counters.queueJobs}\n`);
      process.stdout.write(`- dead_letters: ${counters.deadLetters}\n`);
    }
    process.stdout.write(
      "Note: webhook idempotency keys are not cleared. For a new intake, use a fresh source_uuid or updated_at.\n",
    );
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
