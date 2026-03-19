import type { KeycrmOrder, KeycrmOrderProduct } from "../../domain/orders/order.types";
import { buildFilename } from "./filename-builder";
import { resolveFormat } from "./format-resolver";
import {
  buildCombinedPropertiesMap,
  firstDefinedProperty,
  isTruthyValue,
  isValidHttpUrl,
  normalizeText,
} from "./layout.utils";
import type { LayoutMaterial, LayoutPlan } from "./layout.types";
import type { ProductCodeRules } from "./product-code-rules";
import { resolvePosterCode } from "./sku-classifier";
import { resolveStandType } from "./stand-type-resolver";

type EnrichedProduct = {
  product: KeycrmOrderProduct;
  propertiesMap: Map<string, string>;
  itemKey: string;
  parentKey: string;
};

function containsAnyText(text: string, patterns: string[]): boolean {
  const source = normalizeText(text).toLowerCase();
  if (!source) {
    return false;
  }

  return patterns.some((pattern) => source.includes(pattern));
}

function getOrderProducts(order: KeycrmOrder): KeycrmOrderProduct[] {
  return Array.isArray(order.products) ? order.products : [];
}

function productSku(product: KeycrmOrderProduct): string {
  return normalizeText(product.offer?.sku || product.sku);
}

export class LayoutPlanBuilder {
  private readonly rules: ProductCodeRules;

  constructor(rules: ProductCodeRules) {
    this.rules = rules;
  }

  build(order: KeycrmOrder): LayoutPlan {
    const orderNumber = String(order.id ?? "").trim();
    const products = getOrderProducts(order);
    const enriched = products.map((product) => this.enrichProduct(product));
    const baseProducts = this.selectBaseProducts(enriched);

    const urgent = this.resolveUrgent(enriched);
    const flags = this.collectFlags(enriched);
    const qrRequested = flags.includes("QR +");
    const qrUrl = this.resolveQrUrl(enriched);
    const qrUrlValid = qrRequested ? isValidHttpUrl(qrUrl) : false;
    const previewImages = this.collectPreviewImages(baseProducts);

    const notes: string[] = [];
    if (qrRequested && !qrUrlValid) {
      notes.push("Посилання до QR-коду невалідне, QR файл не згенеровано.");
    }

    const rawMaterials: Array<Omit<LayoutMaterial, "index" | "total" | "filename">> = [];

    for (const base of baseProducts) {
      const linked = this.collectLinkedProducts(base, enriched);
      const format = resolveFormat(base.product, base.propertiesMap, this.rules);
      const standType = resolveStandType(base.product, base.propertiesMap, this.rules);
      const posterCode = resolvePosterCode(base.product, format, this.rules);

      rawMaterials.push({
        type: "poster",
        code: posterCode,
        productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
        sku: productSku(base.product) || null,
        sourceUrl: this.resolvePosterSource(base),
        text: null,
        format,
        standType: null,
      });

      const engravingText = this.findFirstProperty(linked, this.rules.propertyNames.engravingText);
      const stickerText = this.findFirstProperty(linked, this.rules.propertyNames.stickerText);

      const hasEngraving =
        Boolean(engravingText) ||
        this.hasTruthyProperty(linked, this.rules.propertyNames.engravingFlag) ||
        this.hasAddonPattern(linked, ["engraving", "грав"]);

      const hasSticker =
        Boolean(stickerText) ||
        this.hasTruthyProperty(linked, this.rules.propertyNames.stickerFlag) ||
        this.hasAddonPattern(linked, ["sticker", "стікер"]);

      if (hasEngraving) {
        rawMaterials.push({
          type: "engraving",
          code: `${format}${standType}_G`,
          productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
          sku: productSku(base.product) || null,
          sourceUrl: null,
          text: engravingText || null,
          format,
          standType,
        });
      }

      if (hasSticker) {
        rawMaterials.push({
          type: "sticker",
          code: "S",
          productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
          sku: productSku(base.product) || null,
          sourceUrl: null,
          text: stickerText || null,
          format: null,
          standType: null,
        });
      }
    }

    const total = rawMaterials.length;
    const materials = rawMaterials.map((material, index) => ({
      ...material,
      index: index + 1,
      total,
      filename: buildFilename(material.code, orderNumber, index + 1, total, urgent),
    }));

    return {
      orderNumber,
      urgent,
      flags,
      notes,
      previewImages,
      materials,
      qr: {
        requested: qrRequested,
        valid: qrUrlValid,
        shouldGenerate: qrRequested && qrUrlValid,
        originalUrl: qrUrl || null,
        url: qrUrl || null,
      },
    };
  }

  private enrichProduct(product: KeycrmOrderProduct): EnrichedProduct {
    const propertiesMap = buildCombinedPropertiesMap(product);

    return {
      product,
      propertiesMap,
      itemKey: firstDefinedProperty(propertiesMap, this.rules.propertyNames.itemKey),
      parentKey: firstDefinedProperty(propertiesMap, this.rules.propertyNames.parentKey),
    };
  }

  private selectBaseProducts(enriched: EnrichedProduct[]): EnrichedProduct[] {
    const withDesignLink = enriched.filter((item) => {
      return Boolean(
        firstDefinedProperty(item.propertiesMap, this.rules.propertyNames.designLink) ||
          firstDefinedProperty(item.propertiesMap, this.rules.propertyNames.previewImage),
      );
    });

    if (withDesignLink.length > 0) {
      return withDesignLink;
    }

    const roots = enriched.filter((item) => !item.parentKey);
    if (roots.length > 0) {
      return roots;
    }

    return enriched.slice(0, 1);
  }

  private collectLinkedProducts(base: EnrichedProduct, all: EnrichedProduct[]): EnrichedProduct[] {
    if (!base.itemKey) {
      return [base];
    }

    const linkedChildren = all.filter((item) => item.parentKey && item.parentKey === base.itemKey);
    return [base, ...linkedChildren];
  }

  private resolvePosterSource(base: EnrichedProduct): string | null {
    const fromDesignLink = firstDefinedProperty(base.propertiesMap, this.rules.propertyNames.designLink);
    if (fromDesignLink) {
      return fromDesignLink;
    }

    const fromPreview = firstDefinedProperty(base.propertiesMap, this.rules.propertyNames.previewImage);
    if (fromPreview) {
      return fromPreview;
    }

    const picture = base.product.picture;
    if (typeof picture === "string" && picture.trim()) {
      return picture.trim();
    }

    if (picture && typeof picture === "object") {
      const thumbnail = (picture as { thumbnail?: unknown }).thumbnail;
      const medium = (picture as { medium?: unknown }).medium;
      const original = (picture as { original?: unknown }).original;
      const candidate = normalizeText(thumbnail || medium || original);
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  private resolveUrgent(enriched: EnrichedProduct[]): boolean {
    if (this.hasTruthyProperty(enriched, this.rules.propertyNames.urgentFlag)) {
      return true;
    }

    return enriched.some((item) => {
      const source = `${normalizeText(item.product.name)} ${productSku(item.product)}`.toLowerCase();
      return source.includes("термін") || source.includes("urgent");
    });
  }

  private collectFlags(enriched: EnrichedProduct[]): string[] {
    let hasQr = this.hasTruthyProperty(enriched, this.rules.propertyNames.qrFlag);
    let hasLivePhoto = this.hasTruthyProperty(enriched, this.rules.propertyNames.livePhotoFlag);

    for (const item of enriched) {
      const source = `${normalizeText(item.product.name)} ${productSku(item.product)}`.toLowerCase();
      if (!hasQr && source.includes("qr")) {
        hasQr = true;
      }

      if (!hasLivePhoto && source.includes("live photo")) {
        hasLivePhoto = true;
      }
    }

    const flags: string[] = [];
    if (hasQr) {
      flags.push("QR +");
    }
    if (hasLivePhoto) {
      flags.push("LF +");
    }
    return flags;
  }

  private resolveQrUrl(enriched: EnrichedProduct[]): string {
    return this.findFirstProperty(enriched, this.rules.propertyNames.qrUrl);
  }

  private collectPreviewImages(baseProducts: EnrichedProduct[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const base of baseProducts) {
      const url = firstDefinedProperty(base.propertiesMap, this.rules.propertyNames.previewImage);
      if (!url || !isValidHttpUrl(url)) {
        continue;
      }

      if (seen.has(url)) {
        continue;
      }

      seen.add(url);
      result.push(url);
    }

    return result;
  }

  private hasTruthyProperty(products: EnrichedProduct[], names: string[]): boolean {
    for (const item of products) {
      const value = firstDefinedProperty(item.propertiesMap, names);
      if (isTruthyValue(value)) {
        return true;
      }
    }

    return false;
  }

  private findFirstProperty(products: EnrichedProduct[], names: string[]): string {
    for (const item of products) {
      const value = firstDefinedProperty(item.propertiesMap, names);
      if (value) {
        return value;
      }
    }

    return "";
  }

  private hasAddonPattern(products: EnrichedProduct[], patterns: string[]): boolean {
    return products.some((item) => {
      const source = `${normalizeText(item.product.name)} ${productSku(item.product)}`;
      return containsAnyText(source, patterns);
    });
  }
}
