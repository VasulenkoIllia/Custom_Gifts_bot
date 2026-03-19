export type QueueJobStatus = "queued" | "running" | "completed" | "failed";

export type QueueJob<TPayload> = {
  id: string;
  key: string;
  payload: TPayload;
  status: QueueJobStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type QueueEnqueueInput<TPayload> = {
  key: string;
  payload: TPayload;
};

export type QueueEnqueueResult = {
  jobId: string;
  deduplicated: boolean;
  queue: QueueStats;
};

export type QueueStats = {
  name: string;
  concurrency: number;
  maxQueueSize: number;
  pending: number;
  running: number;
  inflightKeys: number;
};

export type QueueHandler<TPayload> = (job: QueueJob<TPayload>) => Promise<void>;

export type QueueStateEvent<TPayload> = {
  queue: string;
  key: string;
  jobId: string;
  status: QueueJobStatus;
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  retryDelayMs: number | null;
  payload: TPayload;
  error?: string;
  stats: QueueStats;
};

export type QueueDeadLetterEvent<TPayload> = {
  queue: string;
  key: string;
  jobId: string;
  attempt: number;
  maxAttempts: number;
  payload: TPayload;
  errorType: string;
  retryable: boolean;
  failureKind: string | null;
  error: string;
  createdAt: number;
  finishedAt: number;
};

export type QueueOptions<TPayload> = {
  name: string;
  concurrency: number;
  maxQueueSize: number;
  jobTimeoutMs: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  shouldRetry?: (params: { error: unknown; job: QueueJob<TPayload> }) => boolean;
  onDeadLetter?: (event: QueueDeadLetterEvent<TPayload>) => void | Promise<void>;
  handler: QueueHandler<TPayload>;
  onStateChange?: (event: QueueStateEvent<TPayload>) => void;
};
