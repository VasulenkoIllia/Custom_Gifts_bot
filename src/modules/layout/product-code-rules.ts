import fs from "node:fs/promises";

export type ProductCodeRules = {
  specialPosterCodesBySku: Record<string, string>;
  propertyNames: {
    designLink: string[];
    previewImage: string[];
    itemKey: string[];
    parentKey: string[];
    variant: string[];
    format: string[];
    standType: string[];
    engravingFlag: string[];
    engravingText: string[];
    stickerFlag: string[];
    stickerText: string[];
    urgentFlag: string[];
    qrFlag: string[];
    qrUrl: string[];
    livePhotoFlag: string[];
  };
};

const DEFAULT_PROPERTY_NAMES: ProductCodeRules["propertyNames"] = {
  designLink: ["_tib_design_link_1"],
  previewImage: ["_customization_image"],
  itemKey: ["_itemKey"],
  parentKey: ["_parentKey"],
  variant: ["Variant", "Варіант"],
  format: ["Розмір", "Оберіть розмір постера", "Format", "Size"],
  standType: ["Тип підставки", "Оберіть тип стійки", "Тип стійки", "Stand type", "Base type"],
  engravingFlag: ["Гравіювання", "Engraving"],
  engravingText: ["Текст для гравіювання", "Text for engraving"],
  stickerFlag: ["Стікер-записка", "Стікер", "Sticker note", "Sticker"],
  stickerText: ["Текст на стікер", "Text on sticker", "Текст для стікера", "Sticker text"],
  urgentFlag: ["Термінове виготовлення", "Термінове", "Urgent"],
  qrFlag: ["QR-код", "QR код", "QR code"],
  qrUrl: ["Посилання до QR-коду", "Посилання до QR коду", "QR link", "Link to QR"],
  livePhotoFlag: ["Live Photo", "Live photo"],
};

function normalizeSkuKey(sku: string): string {
  return String(sku ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeRules(raw: unknown): ProductCodeRules {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const specialPosterCodesBySkuRaw =
    data.specialPosterCodesBySku && typeof data.specialPosterCodesBySku === "object"
      ? (data.specialPosterCodesBySku as Record<string, unknown>)
      : {};

  const specialPosterCodesBySku: Record<string, string> = {};
  for (const [key, value] of Object.entries(specialPosterCodesBySkuRaw)) {
    const normalizedKey = normalizeSkuKey(key);
    const normalizedValue = String(value ?? "").trim().toUpperCase();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    specialPosterCodesBySku[normalizedKey] = normalizedValue;
  }

  const propertyNamesRaw =
    data.propertyNames && typeof data.propertyNames === "object"
      ? (data.propertyNames as Record<string, unknown>)
      : {};

  const propertyNames: ProductCodeRules["propertyNames"] = {
    designLink: Array.isArray(propertyNamesRaw.designLink)
      ? propertyNamesRaw.designLink.map(String)
      : DEFAULT_PROPERTY_NAMES.designLink,
    previewImage: Array.isArray(propertyNamesRaw.previewImage)
      ? propertyNamesRaw.previewImage.map(String)
      : DEFAULT_PROPERTY_NAMES.previewImage,
    itemKey: Array.isArray(propertyNamesRaw.itemKey)
      ? propertyNamesRaw.itemKey.map(String)
      : DEFAULT_PROPERTY_NAMES.itemKey,
    parentKey: Array.isArray(propertyNamesRaw.parentKey)
      ? propertyNamesRaw.parentKey.map(String)
      : DEFAULT_PROPERTY_NAMES.parentKey,
    variant: Array.isArray(propertyNamesRaw.variant)
      ? propertyNamesRaw.variant.map(String)
      : DEFAULT_PROPERTY_NAMES.variant,
    format: Array.isArray(propertyNamesRaw.format)
      ? propertyNamesRaw.format.map(String)
      : DEFAULT_PROPERTY_NAMES.format,
    standType: Array.isArray(propertyNamesRaw.standType)
      ? propertyNamesRaw.standType.map(String)
      : DEFAULT_PROPERTY_NAMES.standType,
    engravingFlag: Array.isArray(propertyNamesRaw.engravingFlag)
      ? propertyNamesRaw.engravingFlag.map(String)
      : DEFAULT_PROPERTY_NAMES.engravingFlag,
    engravingText: Array.isArray(propertyNamesRaw.engravingText)
      ? propertyNamesRaw.engravingText.map(String)
      : DEFAULT_PROPERTY_NAMES.engravingText,
    stickerFlag: Array.isArray(propertyNamesRaw.stickerFlag)
      ? propertyNamesRaw.stickerFlag.map(String)
      : DEFAULT_PROPERTY_NAMES.stickerFlag,
    stickerText: Array.isArray(propertyNamesRaw.stickerText)
      ? propertyNamesRaw.stickerText.map(String)
      : DEFAULT_PROPERTY_NAMES.stickerText,
    urgentFlag: Array.isArray(propertyNamesRaw.urgentFlag)
      ? propertyNamesRaw.urgentFlag.map(String)
      : DEFAULT_PROPERTY_NAMES.urgentFlag,
    qrFlag: Array.isArray(propertyNamesRaw.qrFlag)
      ? propertyNamesRaw.qrFlag.map(String)
      : DEFAULT_PROPERTY_NAMES.qrFlag,
    qrUrl: Array.isArray(propertyNamesRaw.qrUrl)
      ? propertyNamesRaw.qrUrl.map(String)
      : DEFAULT_PROPERTY_NAMES.qrUrl,
    livePhotoFlag: Array.isArray(propertyNamesRaw.livePhotoFlag)
      ? propertyNamesRaw.livePhotoFlag.map(String)
      : DEFAULT_PROPERTY_NAMES.livePhotoFlag,
  };

  return {
    specialPosterCodesBySku,
    propertyNames,
  };
}

export async function loadProductCodeRules(filePath: string): Promise<ProductCodeRules> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeRules(parsed);
}

export function getSpecialPosterCodeBySku(rules: ProductCodeRules, sku: string): string | null {
  const normalizedSku = normalizeSkuKey(sku);
  if (!normalizedSku) {
    return null;
  }

  return rules.specialPosterCodesBySku[normalizedSku] ?? null;
}

export function toSkuKey(sku: string): string {
  return normalizeSkuKey(sku);
}
