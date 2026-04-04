import { randomUUID } from "node:crypto";
import { loadValidatedConfigFromEnv, resolveLocalAppBaseUrl } from "./script-runtime-utils";
import { parsePositiveInteger } from "./script-utils";

type ParsedArgs = {
  orderId: string;
  statusId: number;
  appBaseUrl: string | null;
  updatedAt: string;
  sourceUuid: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  let orderId = "";
  let statusId = 20;
  let appBaseUrl: string | null = null;
  let updatedAt = new Date().toISOString();
  let sourceUuid: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--order-id=")) {
      orderId = arg.slice("--order-id=".length).trim();
      continue;
    }

    if (arg.startsWith("--status-id=")) {
      statusId = parsePositiveInteger(arg.slice("--status-id=".length), 20);
      continue;
    }

    if (arg.startsWith("--app-base-url=")) {
      appBaseUrl = arg.slice("--app-base-url=".length).trim();
      continue;
    }

    if (arg.startsWith("--updated-at=")) {
      updatedAt = arg.slice("--updated-at=".length).trim() || updatedAt;
      continue;
    }

    if (arg.startsWith("--source-uuid=")) {
      sourceUuid = arg.slice("--source-uuid=".length).trim() || null;
      continue;
    }
  }

  return {
    orderId,
    statusId,
    appBaseUrl,
    updatedAt,
    sourceUuid,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!/^\d+$/.test(args.orderId)) {
    throw new Error("Valid --order-id=... is required.");
  }

  const config = loadValidatedConfigFromEnv();
  const appBaseUrl = args.appBaseUrl || resolveLocalAppBaseUrl(config);
  const payload = {
    event: "order.change_order_status",
    context: {
      id: Number.parseInt(args.orderId, 10),
      status_id: args.statusId,
      updated_at: args.updatedAt,
      source_uuid: args.sourceUuid || `manual-trigger-${args.orderId}-${randomUUID()}`,
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.keycrmWebhookSecret) {
    headers["x-keycrm-webhook-secret"] = config.keycrmWebhookSecret;
  }

  const response = await fetch(`${appBaseUrl}/webhook/keycrm`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  process.stdout.write(`request=${JSON.stringify(payload)}\n`);
  process.stdout.write(`status=${response.status}\n`);
  process.stdout.write(`${rawText}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
