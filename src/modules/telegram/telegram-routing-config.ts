export type TelegramForwardMode = "copy" | "forward";

export type TelegramDestinationCode = "processing" | "orders" | "ops";

export type TelegramDestination = {
  chatId: string;
  threadId: string;
};

export type TelegramRoutingConfig = {
  forwardMode: TelegramForwardMode;
  destinations: Record<TelegramDestinationCode, TelegramDestination>;
};
