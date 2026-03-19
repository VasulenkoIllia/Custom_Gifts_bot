export type OrderIntakeJobPayload = {
  orderId: string;
  statusId: number | null;
  webhookEvent: string;
  sourceUuid: string | null;
  receivedAt: string;
};

export type ReactionIntakeJobPayload = {
  updateId: number | null;
  chatId: string | null;
  messageId: number | null;
  heartCount: number | null;
  receivedAt: string;
};
