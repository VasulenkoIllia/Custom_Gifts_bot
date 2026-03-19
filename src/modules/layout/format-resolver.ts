import type { KeycrmOrderProduct } from "../../domain/orders/order.types";
import { extractFormatFromText, firstDefinedProperty, normalizeText } from "./layout.utils";
import type { ProductCodeRules } from "./product-code-rules";

function parseFormatFromSku(sku: string): "A5" | "A4" | null {
  return extractFormatFromText(sku);
}

export function resolveFormat(
  product: KeycrmOrderProduct,
  combinedProperties: Map<string, string>,
  rules: ProductCodeRules,
): "A5" | "A4" {
  const skuCandidates = [product.offer?.sku, product.sku]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const sku of skuCandidates) {
    const parsed = parseFormatFromSku(sku);
    if (parsed) {
      return parsed;
    }
  }

  const fromProperties = extractFormatFromText(
    firstDefinedProperty(combinedProperties, rules.propertyNames.format),
  );
  if (fromProperties) {
    return fromProperties;
  }

  const fromVariant = extractFormatFromText(
    firstDefinedProperty(combinedProperties, rules.propertyNames.variant),
  );
  if (fromVariant) {
    return fromVariant;
  }

  const fromName = extractFormatFromText(
    `${normalizeText(product.name)} ${normalizeText(product.offer?.sku)} ${normalizeText(product.sku)}`,
  );

  if (fromName) {
    return fromName;
  }

  return "A5";
}
