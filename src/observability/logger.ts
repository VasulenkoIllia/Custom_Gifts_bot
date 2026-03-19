type LoggerMeta = Record<string, unknown>;

export type Logger = {
  info: (event: string, meta?: LoggerMeta) => void;
  warn: (event: string, meta?: LoggerMeta) => void;
  error: (event: string, meta?: LoggerMeta) => void;
};

type CreateLoggerParams = {
  service: string;
};

export function createLogger({ service }: CreateLoggerParams): Logger {
  const write = (level: string, event: string, meta: LoggerMeta = {}): void => {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event,
      ...meta,
    };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    info: (event, meta) => {
      write("info", event, meta);
    },
    warn: (event, meta) => {
      write("warn", event, meta);
    },
    error: (event, meta) => {
      write("error", event, meta);
    },
  };
}
