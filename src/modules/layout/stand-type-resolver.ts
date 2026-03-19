import type { KeycrmOrderProduct } from "../../domain/orders/order.types";
import { firstDefinedProperty, normalizeText } from "./layout.utils";
import type { ProductCodeRules } from "./product-code-rules";

export type StandType = "W" | "WW" | "MWW" | "C" | "K";

function normalizeSource(text: string): string {
  return normalizeText(text).toLowerCase().replace(/[ʼ']/g, "");
}

function parseStandTypeFromText(text: string): StandType | null {
  const source = normalizeSource(text);
  if (!source) {
    return null;
  }

  if (
    source.includes("+k") ||
    source.includes("speaker") ||
    source.includes("колонк") ||
    source.includes("з колонкою")
  ) {
    return "K";
  }

  if (
    source.includes("mww") ||
    source.includes("multiww") ||
    source.includes("multi ww") ||
    source.includes("multi white") ||
    source.includes("мульти")
  ) {
    return "MWW";
  }

  if (source.includes("ww") || source.includes("warm white") || source.includes("тепла")) {
    return "WW";
  }

  if (
    source.includes("rgb") ||
    source.includes("rbg") ||
    source.includes("color") ||
    source.includes("кольор")
  ) {
    return "C";
  }

  if (source.includes("wood") || source.includes("дерев") || /a[45]w($|[^a-z0-9])/i.test(source)) {
    return "W";
  }

  return null;
}

export function resolveStandType(
  product: KeycrmOrderProduct,
  combinedProperties: Map<string, string>,
  rules: ProductCodeRules,
): StandType {
  const skuCandidates = [product.offer?.sku, product.sku]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const sku of skuCandidates) {
    const parsed = parseStandTypeFromText(sku);
    if (parsed) {
      return parsed;
    }
  }

  const fromProperties = parseStandTypeFromText(
    firstDefinedProperty(combinedProperties, rules.propertyNames.standType),
  );
  if (fromProperties) {
    return fromProperties;
  }

  const fromVariant = parseStandTypeFromText(
    firstDefinedProperty(combinedProperties, rules.propertyNames.variant),
  );
  if (fromVariant) {
    return fromVariant;
  }

  const fromName = parseStandTypeFromText(
    `${normalizeText(product.name)} ${normalizeText(product.offer?.sku)} ${normalizeText(product.sku)}`,
  );
  if (fromName) {
    return fromName;
  }

  return "W";
}
