import path from "node:path";
import { createCrmClientFromConfig, loadValidatedConfigFromEnv } from "./script-runtime-utils";
import {
  DEFAULT_TEST_SET_PATH,
  loadOrderIdsFromTestSet,
  normalizeOrderIds,
  parsePositiveInteger,
} from "./script-utils";

type ParsedArgs = {
  orderIds: string[];
  statusId: number;
  testSetPath: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const orderIdArgs: string[] = [];
  let statusId = 20;
  let testSetPath = DEFAULT_TEST_SET_PATH;

  for (const arg of argv) {
    if (arg.startsWith("--order-ids=")) {
      orderIdArgs.push(arg.slice("--order-ids=".length));
      continue;
    }

    if (arg.startsWith("--status-id=")) {
      statusId = parsePositiveInteger(arg.slice("--status-id=".length), 20);
      continue;
    }

    if (arg.startsWith("--test-set=")) {
      testSetPath = path.resolve(process.cwd(), arg.slice("--test-set=".length));
      continue;
    }

    orderIdArgs.push(arg);
  }

  return {
    orderIds: normalizeOrderIds(orderIdArgs),
    statusId,
    testSetPath,
  };
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

  for (const orderId of orderIds) {
    const before = await crmClient.getOrder(orderId);
    const beforeStatusId = Number.parseInt(String(before.status_id ?? ""), 10);
    const updated = await crmClient.updateOrderStatus(orderId, args.statusId);
    const afterStatusId = Number.parseInt(String(updated.status_id ?? ""), 10);
    process.stdout.write(
      `order=${orderId} before=${Number.isFinite(beforeStatusId) ? beforeStatusId : "unknown"} after=${Number.isFinite(afterStatusId) ? afterStatusId : "unknown"}\n`,
    );
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
