import { bootstrap } from "./app/bootstrap";

function writeStderr(event: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "custom-gifts-bot",
      event,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
}

process.on("unhandledRejection", (reason) => {
  writeStderr("unhandled_rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  writeStderr("uncaught_exception", error);
  process.exit(1);
});

void bootstrap().catch((error) => {
  writeStderr("bootstrap_failed", error);
  process.exit(1);
});
