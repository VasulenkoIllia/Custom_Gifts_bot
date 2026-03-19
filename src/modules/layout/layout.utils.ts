import type { KeycrmOrderProduct } from "../../domain/orders/order.types";

export type PropertiesMap = Map<string, string>;

export function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

export function isTruthyValue(value: unknown): boolean {
  const normalized = normalizeKey(value);
  return (
    normalized === "так" ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "додати" ||
    normalized === "add"
  );
}

export function createPropertiesMap(properties: unknown): PropertiesMap {
  const result = new Map<string, string>();
  const list = Array.isArray(properties) ? properties : [];

  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as { name?: unknown; value?: unknown };
    const key = normalizeKey(candidate.name);
    if (!key) {
      continue;
    }

    result.set(key, normalizeText(candidate.value));
  }

  return result;
}

export function buildCombinedPropertiesMap(product: KeycrmOrderProduct): PropertiesMap {
  const result = new Map<string, string>();
  const productMap = createPropertiesMap(product.properties);
  const offerMap = createPropertiesMap(product.offer?.properties);

  for (const [key, value] of offerMap.entries()) {
    result.set(key, value);
  }

  for (const [key, value] of productMap.entries()) {
    result.set(key, value);
  }

  return result;
}

export function firstDefinedProperty(propertiesMap: PropertiesMap, names: string[]): string {
  for (const name of names) {
    const key = normalizeKey(name);
    if (!key) {
      continue;
    }

    const value = propertiesMap.get(key);
    if (value && value.trim()) {
      return value;
    }
  }

  return "";
}

export function isValidHttpUrl(value: string): boolean {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

export function extractFormatFromText(text: string): "A5" | "A4" | null {
  const normalized = normalizeText(text).replace(/[Аа]/g, "A");
  const match = normalized.match(/A\s*([45])/i);
  if (!match) {
    return null;
  }

  return match[1] === "4" ? "A4" : "A5";
}
