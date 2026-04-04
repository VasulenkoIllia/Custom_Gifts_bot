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

type ManualMaterialsState = {
  hasA6: boolean;
  hasKeychain: boolean;
  count: number;
};

type PlannedMaterialEntry = {
  type: "poster" | "engraving" | "sticker";
  code: string;
  payload: Omit<LayoutMaterial, "index" | "total" | "filename"> | null;
  warningMessage?: string;
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
    const manualMaterials = this.resolveManualMaterials(enriched);
    const flags = this.collectFlags(enriched, manualMaterials);
    const qrRequested = flags.includes("QR +");
    const qrUrl = this.resolveQrUrl(enriched);
    const qrUrlValid = qrRequested ? isValidHttpUrl(qrUrl) : false;
    const previewImages = this.collectPreviewImages(baseProducts);

    const notes = new Set<string>();
    if (qrRequested && !qrUrlValid) {
      notes.add("🚨 Посилання QR невалідне. QR не згенеровано і не вбудовано в макет.");
    }
    for (const warning of this.collectPreviewWarnings(baseProducts)) {
      notes.add(warning);
    }
    for (const warning of this.collectUnlinkedAddonWarnings(enriched, baseProducts)) {
      notes.add(warning);
    }

    const plannedMaterials: PlannedMaterialEntry[] = [];

    for (const base of baseProducts) {
      const linked = this.collectLinkedProducts(base, enriched);
      const format = resolveFormat(base.product, base.propertiesMap, this.rules);
      const standType = resolveStandType(base.product, base.propertiesMap, this.rules);
      const posterCode = resolvePosterCode(base.product, format, this.rules);

      plannedMaterials.push({
        type: "poster",
        code: posterCode,
        payload: {
          type: "poster",
          code: posterCode,
          productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
          sku: productSku(base.product) || null,
          sourceUrl: this.resolvePosterSource(base),
          text: null,
          format,
          standType: null,
        },
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
        plannedMaterials.push({
          type: "engraving",
          code: `${format}${standType}_G`,
          payload: engravingText
            ? {
                type: "engraving",
                code: `${format}${standType}_G`,
                productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
                sku: productSku(base.product) || null,
                sourceUrl: null,
                text: engravingText,
                format,
                standType,
              }
            : null,
          warningMessage: engravingText
            ? undefined
            : "🚨 Замовлено гравіювання, але текст відсутній.",
        });
      }

      if (hasSticker) {
        plannedMaterials.push({
          type: "sticker",
          code: "S",
          payload: stickerText
            ? {
                type: "sticker",
                code: "S",
                productId: Number.isFinite(Number(base.product.id)) ? Number(base.product.id) : null,
                sku: productSku(base.product) || null,
                sourceUrl: null,
                text: stickerText,
                format: null,
                standType: null,
              }
            : null,
          warningMessage: stickerText
            ? undefined
            : "🚨 Замовлено стікер, але текст відсутній.",
        });
      }
    }

    const total = plannedMaterials.length + manualMaterials.count;
    const materials: LayoutPlan["materials"] = [];
    plannedMaterials.forEach((entry, index) => {
      const filename = buildFilename(entry.code, orderNumber, index + 1, total, urgent);

      if (entry.payload) {
        materials.push({
          ...entry.payload,
          index: index + 1,
          total,
          filename,
        });

        if (entry.type === "poster" && !entry.payload.sourceUrl) {
          const label = this.describeProduct(entry.payload.sku, null, filename);
          notes.add(
            `🚨 Для ${label} відсутній друкарський файл (_tib_design_link_1). Preview не використовується як source для друку.`,
          );
        }

        return;
      }

      if (entry.warningMessage) {
        notes.add(`${entry.warningMessage} Файл ${filename} не згенеровано.`);
      }
    });

    return {
      orderNumber,
      urgent,
      flags,
      notes: Array.from(notes),
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
    if (fromDesignLink && isValidHttpUrl(fromDesignLink)) {
      return fromDesignLink;
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

  private collectFlags(
    enriched: EnrichedProduct[],
    manualMaterials: ManualMaterialsState,
  ): string[] {
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
    if (manualMaterials.hasA6) {
      flags.push("A6 +");
    }
    if (manualMaterials.hasKeychain) {
      flags.push("B +");
    }
    return flags;
  }

  private resolveManualMaterials(enriched: EnrichedProduct[]): ManualMaterialsState {
    const hasA6 =
      this.hasTruthyProperty(enriched, this.rules.propertyNames.manualA6Flag) ||
      this.hasManualA6Pattern(enriched);
    const hasKeychain =
      this.hasTruthyProperty(enriched, this.rules.propertyNames.keychainFlag) ||
      this.hasAddonPattern(enriched, ["брелок", "keychain"]);

    return {
      hasA6,
      hasKeychain,
      count: Number(hasA6) + Number(hasKeychain),
    };
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

  private collectPreviewWarnings(baseProducts: EnrichedProduct[]): string[] {
    const warnings = new Set<string>();

    for (const base of baseProducts) {
      const previewUrl = firstDefinedProperty(base.propertiesMap, this.rules.propertyNames.previewImage);
      if (!previewUrl) {
        continue;
      }

      if (isValidHttpUrl(previewUrl)) {
        continue;
      }

      warnings.add(
        `⚠️ Для ${this.describeProduct(productSku(base.product), normalizeText(base.product.name))} _customization_image невалідний, прев'ю не додано.`,
      );
    }

    return Array.from(warnings);
  }

  private collectUnlinkedAddonWarnings(
    enriched: EnrichedProduct[],
    baseProducts: EnrichedProduct[],
  ): string[] {
    const baseItemKeys = new Set(
      baseProducts.map((item) => item.itemKey).filter((item): item is string => Boolean(item)),
    );
    const linkedProducts = new Set<EnrichedProduct>();

    for (const base of baseProducts) {
      for (const item of this.collectLinkedProducts(base, enriched)) {
        linkedProducts.add(item);
      }
    }

    const warnings = new Set<string>();

    for (const item of enriched) {
      if (linkedProducts.has(item)) {
        continue;
      }

      if (this.isManualStandaloneAddon(item)) {
        continue;
      }

      if (!this.isWarnableAddon(item)) {
        continue;
      }

      const label = this.describeProduct(productSku(item.product), normalizeText(item.product.name));
      const alternativeParentKeys = Array.from(item.propertiesMap.keys()).filter(
        (key) => key.startsWith("_parentkey_") && key !== "_parentkey",
      );

      if (alternativeParentKeys.length > 0) {
        warnings.add(
          `⚠️ Додаткова позиція ${label} має нестандартний ключ прив'язки (${alternativeParentKeys.join(", ")}). Перевірте комплект вручну.`,
        );
        continue;
      }

      if (item.parentKey && !baseItemKeys.has(item.parentKey)) {
        warnings.add(
          `⚠️ Додаткова позиція ${label} не прив'язана до жодного основного макета. Перевірте комплект вручну.`,
        );
        continue;
      }

      if (!item.parentKey) {
        warnings.add(
          `⚠️ Додаткова позиція ${label} не прив'язана до основного макета. Перевірте комплект вручну.`,
        );
      }
    }

    return Array.from(warnings);
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

  private hasManualA6Pattern(products: EnrichedProduct[]): boolean {
    return products.some((item) => this.containsA6Token(this.buildManualDetectionText(item)));
  }

  private isManualStandaloneAddon(item: EnrichedProduct): boolean {
    const text = this.buildManualDetectionText(item);
    if (this.containsA6Token(text)) {
      return true;
    }

    return containsAnyText(text, ["брелок", "keychain"]);
  }

  private isWarnableAddon(item: EnrichedProduct): boolean {
    const source = `${normalizeText(item.product.name)} ${productSku(item.product)} ${normalizeText(item.product.comment)}`;
    return containsAnyText(source, ["engraving", "грав", "sticker", "стікер", "qr"]);
  }

  private describeProduct(sku: string | null, name: string | null, fallback?: string): string {
    const normalizedSku = normalizeText(sku);
    if (normalizedSku) {
      return `"${normalizedSku}"`;
    }

    const normalizedName = normalizeText(name);
    if (normalizedName) {
      return `"${normalizedName}"`;
    }

    return fallback ? `"${fallback}"` : "товару";
  }

  private buildManualDetectionText(item: EnrichedProduct): string {
    const segments = [
      normalizeText(item.product.name),
      productSku(item.product),
      normalizeText(item.product.comment),
    ];

    for (const [key, value] of item.propertiesMap.entries()) {
      if (!isValidHttpUrl(value)) {
        segments.push(key, value);
      } else {
        segments.push(key);
      }
    }

    return segments.join(" ");
  }

  private containsA6Token(text: string): boolean {
    const normalized = normalizeText(text).replace(/[Аа]/g, "A");
    return /(^|[^A-Z0-9])A\s*6([^A-Z0-9]|$)/i.test(normalized);
  }
}
