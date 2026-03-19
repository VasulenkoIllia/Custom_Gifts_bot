import type { KeycrmOrderProduct } from "../../domain/orders/order.types";
import type { ProductCodeRules } from "./product-code-rules";
import { getSpecialPosterCodeBySku } from "./product-code-rules";
import { normalizeText } from "./layout.utils";

export function resolvePosterCode(
  product: KeycrmOrderProduct,
  format: "A5" | "A4",
  rules: ProductCodeRules,
): string {
  const skuCandidates = [product.offer?.sku, product.sku]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const sku of skuCandidates) {
    const specialCode = getSpecialPosterCodeBySku(rules, sku);
    if (specialCode) {
      return specialCode;
    }
  }

  return `A${format}`;
}
