export type TelegramMessageMapEntry = {
  key: string;
  orderId: string;
  chatId: string;
  messageId: number;
  createdAt: string;
  updatedAt: string;
  lastHeartCount: number;
};

export type TelegramOrderWorkflowState = {
  orderId: string;
  highestStageIndex: number;
  appliedStatusId: number | null;
  updatedAt: string;
  lastHeartCount: number;
};

export type TelegramMessageMapStore = {
  init: () => Promise<void>;
  linkMessages: (params: {
    orderId: string;
    chatId: string;
    messageIds: number[];
  }) => Promise<{ linked: number }>;
  getOrderIdByMessage: (chatId: string, messageId: number) => Promise<string | null>;
  markMessageHeartCount: (chatId: string, messageId: number, heartCount: number) => Promise<void>;
  getOrderState: (orderId: string) => Promise<TelegramOrderWorkflowState | null>;
  upsertOrderState: (params: {
    orderId: string;
    highestStageIndex: number;
    appliedStatusId: number;
    lastHeartCount: number;
  }) => Promise<TelegramOrderWorkflowState>;
};
