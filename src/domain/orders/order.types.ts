export type KeycrmProductProperty = {
  name: string;
  value: string;
};

export type KeycrmOffer = {
  id?: number;
  sku?: string;
  properties?: KeycrmProductProperty[];
};

export type KeycrmOrderProduct = {
  id?: number;
  sku?: string;
  name?: string;
  comment?: string;
  picture?: string;
  properties?: KeycrmProductProperty[];
  offer?: KeycrmOffer;
};

export type KeycrmOrder = {
  id: number;
  status_id?: number;
  source_id?: number;
  source_uuid?: string;
  products?: KeycrmOrderProduct[];
  [key: string]: unknown;
};
