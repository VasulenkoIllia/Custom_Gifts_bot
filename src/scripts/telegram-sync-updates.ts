import fs from "node:fs/promises";
import path from "node:path";
import { loadValidatedConfigFromEnv, resolveLocalAppBaseUrl } from "./script-runtime-utils";
import { ensureParentDir, parsePositiveInteger } from "./script-utils";

type ParsedArgs = {
  appBaseUrl: string | null;
  stateFile: string;
  timeoutSeconds: number;
  limit: number;
  watch: boolean;
  resetOffset: boolean;
  pollIntervalMs: number;
};

type TelegramUpdate = {
  update_id?: number;
  [key: string]: unknown;
};

type TelegramEnvelope = {
  ok?: boolean;
  result?: TelegramUpdate[];
  description?: string;
  error_code?: number;
};

type SyncState = {
  lastUpdateId: number;
  updatedAt: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  let appBaseUrl: string | null = null;
  let stateFile = path.resolve(
    process.cwd(),
    "storage/temp/telegram-reaction-sync-state.json",
  );
  let timeoutSeconds = 3;
  let limit = 100;
  let watch = false;
  let resetOffset = false;
  let pollIntervalMs = 1500;

  for (const arg of argv) {
    if (arg.startsWith("--app-base-url=")) {
      appBaseUrl = arg.slice("--app-base-url=".length).trim() || null;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      stateFile = path.resolve(process.cwd(), arg.slice("--state-file=".length));
      continue;
    }

    if (arg.startsWith("--timeout-seconds=")) {
      timeoutSeconds = parsePositiveInteger(arg.slice("--timeout-seconds=".length), 3);
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(arg.slice("--limit=".length), 100);
      continue;
    }

    if (arg.startsWith("--poll-interval-ms=")) {
      pollIntervalMs = parsePositiveInteger(arg.slice("--poll-interval-ms=".length), 1500);
      continue;
    }

    if (arg === "--watch") {
      watch = true;
      continue;
    }

    if (arg === "--reset-offset") {
      resetOffset = true;
    }
  }

  return {
    appBaseUrl,
    stateFile,
    timeoutSeconds,
    limit,
    watch,
    resetOffset,
    pollIntervalMs,
  };
}

async function readState(filePath: string): Promise<SyncState | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    const lastUpdateId = Number.parseInt(String(parsed.lastUpdateId ?? ""), 10);
    if (!Number.isFinite(lastUpdateId) || lastUpdateId < 0) {
      return null;
    }
    return {
      lastUpdateId,
      updatedAt: String(parsed.updatedAt ?? "").trim(),
    };
  } catch (_error) {
    return null;
  }
}

async function writeState(filePath: string, state: SyncState): Promise<void> {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function fetchTelegramUpdates(params: {
  token: string;
  offset: number | null;
  timeoutSeconds: number;
  limit: number;
}): Promise<TelegramUpdate[]> {
  const response = await fetch(`https://api.telegram.org/bot${params.token}/getUpdates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      offset: params.offset ?? undefined,
      timeout: params.timeoutSeconds,
      limit: params.limit,
      allowed_updates: ["message_reaction", "message_reaction_count"],
    }),
  });

  const rawText = await response.text();
  let payload: TelegramEnvelope | null = null;
  try {
    payload = JSON.parse(rawText) as TelegramEnvelope;
  } catch (_error) {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    const description = payload?.description || rawText || `HTTP ${response.status}`;
    throw new Error(`Telegram getUpdates failed: ${description}`);
  }

  return Array.isArray(payload.result) ? payload.result : [];
}

async function postUpdatesToLocalWebhook(params: {
  appBaseUrl: string;
  updates: TelegramUpdate[];
  secretToken: string;
}): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.secretToken) {
    headers["x-telegram-bot-api-secret-token"] = params.secretToken;
  }

  const response = await fetch(`${params.appBaseUrl}/webhook/telegram`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      result: params.updates,
    }),
  });

  return {
    status: response.status,
    body: await response.text(),
  };
}

async function syncOnce(params: {
  token: string;
  appBaseUrl: string;
  secretToken: string;
  stateFile: string;
  timeoutSeconds: number;
  limit: number;
  resetOffset: boolean;
}): Promise<number> {
  const state = params.resetOffset ? null : await readState(params.stateFile);
  const offset =
    state && Number.isFinite(state.lastUpdateId) ? Math.max(0, state.lastUpdateId + 1) : null;

  const updates = await fetchTelegramUpdates({
    token: params.token,
    offset,
    timeoutSeconds: params.timeoutSeconds,
    limit: params.limit,
  });

  if (updates.length === 0) {
    process.stdout.write("telegram_sync_updates: no new reaction updates\n");
    return 0;
  }

  const maxUpdateId = updates.reduce((currentMax, item) => {
    const value = Number.parseInt(String(item.update_id ?? ""), 10);
    return Number.isFinite(value) ? Math.max(currentMax, value) : currentMax;
  }, offset ?? 0);

  const localResult = await postUpdatesToLocalWebhook({
    appBaseUrl: params.appBaseUrl,
    updates,
    secretToken: params.secretToken,
  });

  if (localResult.status < 200 || localResult.status >= 300) {
    throw new Error(
      `Local Telegram webhook endpoint failed (${localResult.status}): ${localResult.body}`,
    );
  }

  await writeState(params.stateFile, {
    lastUpdateId: maxUpdateId,
    updatedAt: new Date().toISOString(),
  });

  process.stdout.write(
    `telegram_sync_updates: posted=${updates.length} max_update_id=${maxUpdateId} local_status=${localResult.status}\n`,
  );
  process.stdout.write(`${localResult.body}\n`);
  return updates.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadValidatedConfigFromEnv();
  const appBaseUrl = args.appBaseUrl || resolveLocalAppBaseUrl(config);

  let shouldResetOffset = args.resetOffset;
  let stopped = false;
  if (args.watch) {
    process.stdout.write(
      `telegram_sync_updates: watch mode started app_base_url=${appBaseUrl} state_file=${args.stateFile}\n`,
    );
    process.on("SIGINT", () => {
      stopped = true;
    });
    process.on("SIGTERM", () => {
      stopped = true;
    });
  }

  do {
    try {
      await syncOnce({
        token: config.telegramBotToken,
        appBaseUrl,
        secretToken: config.telegramReactionSecretToken,
        stateFile: args.stateFile,
        timeoutSeconds: args.timeoutSeconds,
        limit: args.limit,
        resetOffset: shouldResetOffset,
      });
      shouldResetOffset = false;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      if (!args.watch) {
        process.exitCode = 1;
        return;
      }
    }

    if (!args.watch || stopped) {
      break;
    }

    await sleep(args.pollIntervalMs);
  } while (!stopped);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
