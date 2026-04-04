import { bootstrap } from "./app/bootstrap";

void bootstrap().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "custom-gifts-bot",
      event: "bootstrap_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
