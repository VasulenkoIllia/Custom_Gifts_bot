export type MaterialType = "poster" | "engraving" | "sticker";

export type LayoutMaterial = {
  type: MaterialType;
  code: string;
  index: number;
  total: number;
  filename: string;
  productId: number | null;
  sku: string | null;
  sourceUrl: string | null;
  text: string | null;
  format: "A5" | "A4" | null;
  standType: "W" | "WW" | "MWW" | "C" | "K" | null;
};

export type LayoutQrMeta = {
  requested: boolean;
  valid: boolean;
  shouldGenerate: boolean;
  originalUrl: string | null;
  url: string | null;
};

export type LayoutPlan = {
  orderNumber: string;
  urgent: boolean;
  flags: string[];
  notes: string[];
  previewImages: string[];
  materials: LayoutMaterial[];
  qr: LayoutQrMeta;
};
