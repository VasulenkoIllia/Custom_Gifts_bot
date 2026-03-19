export type QueueJobStatus = "queued" | "running" | "completed" | "failed";

export type QueueJob<TPayload> = {
  id: string;
  key: string;
  payload: TPayload;
  status: QueueJobStatus;
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
  payload: TPayload;
  error?: string;
  stats: QueueStats;
};

export type QueueOptions<TPayload> = {
  name: string;
  concurrency: number;
  maxQueueSize: number;
  jobTimeoutMs: number;
  handler: QueueHandler<TPayload>;
  onStateChange?: (event: QueueStateEvent<TPayload>) => void;
};
