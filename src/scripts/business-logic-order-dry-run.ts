import fs from "node:fs/promises";
import path from "node:path";
import type { KeycrmOrder, KeycrmOrderProduct } from "../domain/orders/order.types";
import { CrmClient } from "../modules/crm/crm-client";
import {
  buildCombinedPropertiesMap,
  firstDefinedProperty,
  isValidHttpUrl,
  normalizeText,
} from "../modules/layout/layout.utils";
import { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { loadProductCodeRules } from "../modules/layout/product-code-rules";
import { loadQrRules, resolveQrCodeDecision } from "../modules/qr/qr-rules";
import type { Logger } from "../observability/logger";

type TestOrderSet = {
  orderIds?: string[];
  scenarios?: Record<string, string>;
};

type ReportSeverity = "info" | "warning" | "critical";

type ReportRisk = {
  severity: ReportSeverity;
  code: string;
  message: string;
};

type OrderReport = {
  orderId: string;
  scenario: string;
  statusId: number | null;
  sourceId: number | null;
  productCount: number;
  autoMaterials: number;
  totalMaterials: number;
  flags: string[];
  notes: string[];
  filenames: string[];
  qrOutcomes: string[];
  risks: ReportRisk[];
};

type ParsedArgs = {
  orderIds: string[];
  json: boolean;
  testSetPath: string;
};

type EnrichedProduct = {
  product: KeycrmOrderProduct;
  propertiesMap: Map<string, string>;
  itemKey: string;
  parentKey: string;
};

const DEFAULT_TEST_SET_PATH = path.resolve(
  process.cwd(),
  "config/test-orders/business-logic-order-set.json",
);
const MATERIALS_STATUS_ID = 20;

function createSilentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOrderIds(values: string[]): string[] {
  const result: string[] = [];

  for (const value of values) {
    for (const part of value.split(",")) {
      const normalized = part.trim();
      if (/^\d+$/.test(normalized)) {
        result.push(normalized);
      }
    }
  }

  return Array.from(new Set(result));
}

function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let testSetPath = DEFAULT_TEST_SET_PATH;
  const orderIdArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("--test-set=")) {
      testSetPath = path.resolve(process.cwd(), arg.slice("--test-set=".length));
      continue;
    }

    if (arg.startsWith("--order-ids=")) {
      orderIdArgs.push(arg.slice("--order-ids=".length));
      continue;
    }

    orderIdArgs.push(arg);
  }

  return {
    orderIds: normalizeOrderIds(orderIdArgs),
    json,
    testSetPath,
  };
}

function asInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function productSku(product: KeycrmOrderProduct): string {
  return normalizeText(product.offer?.sku || product.sku);
}

function containsToken(text: string, patterns: string[]): boolean {
  const source = normalizeText(text).toLowerCase();
  if (!source) {
    return false;
  }

  return patterns.some((pattern) => source.includes(pattern));
}

function isAddonLikeProduct(product: KeycrmOrderProduct): boolean {
  const source = `${normalizeText(product.name)} ${productSku(product)} ${normalizeText(product.comment)}`;
  return containsToken(source, [
    "грав",
    "engraving",
    "стікер",
    "sticker",
    "qr",
    "live photo",
    "брелок",
    "keychain",
    "a6",
    "a 6",
  ]);
}

function enrichProducts(order: KeycrmOrder): EnrichedProduct[] {
  const products = Array.isArray(order.products) ? order.products : [];
  return products.map((product) => {
    const propertiesMap = buildCombinedPropertiesMap(product);
    return {
      product,
      propertiesMap,
      itemKey: firstDefinedProperty(propertiesMap, ["_itemKey"]),
      parentKey: firstDefinedProperty(propertiesMap, ["_parentKey"]),
    };
  });
}

function selectBaseProducts(enriched: EnrichedProduct[]): EnrichedProduct[] {
  const withDesignOrPreview = enriched.filter((item) => {
    return Boolean(
      firstDefinedProperty(item.propertiesMap, ["_tib_design_link_1"]) ||
        firstDefinedProperty(item.propertiesMap, ["_customization_image"]),
    );
  });

  if (withDesignOrPreview.length > 0) {
    return withDesignOrPreview;
  }

  const roots = enriched.filter((item) => !item.parentKey);
  if (roots.length > 0) {
    return roots;
  }

  return enriched.slice(0, 1);
}

function formatRisk(risk: ReportRisk): string {
  return `${risk.severity.toUpperCase()} ${risk.code}: ${risk.message}`;
}

async function loadTestOrderSet(filePath: string): Promise<TestOrderSet> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as TestOrderSet;
  return {
    orderIds: Array.isArray(parsed.orderIds) ? parsed.orderIds.map(String) : [],
    scenarios:
      parsed.scenarios && typeof parsed.scenarios === "object"
        ? Object.fromEntries(
            Object.entries(parsed.scenarios).map(([key, value]) => [String(key), String(value)]),
          )
        : {},
  };
}

function createReport(
  order: KeycrmOrder,
  scenario: string,
  builder: LayoutPlanBuilder,
  enriched: EnrichedProduct[],
  qrRules: Awaited<ReturnType<typeof loadQrRules>>,
): OrderReport {
  const plan = builder.build(order);
  const baseProducts = selectBaseProducts(enriched);
  const risks: ReportRisk[] = [];

  const qrOutcomes = plan.materials
    .filter((material) => material.type === "poster")
    .map((material) => {
      const decision = resolveQrCodeDecision({
        rules: qrRules,
        sku: material.sku ?? "",
        format: material.format ?? "A5",
        qrRequested: plan.qr.requested,
        qrValid: plan.qr.valid,
        qrUrl: plan.qr.url,
      });
      return `${material.sku || "unknown"} -> ${decision.reason}`;
    });

  const topLevelAddons = enriched
    .filter((item) => !item.parentKey && isAddonLikeProduct(item.product))
    .map((item) => `${normalizeText(item.product.name) || "unnamed"} (${productSku(item.product) || "no-sku"})`);

  const alternativeParentKeys = enriched
    .flatMap((item) => {
      const matches = Array.from(item.propertiesMap.keys()).filter(
        (key) => key.startsWith("_parentkey_") && key !== "_parentkey",
      );
      return matches.map((key) => `${normalizeText(item.product.name) || "unnamed"} -> ${key}`);
    });

  const missingDesignSourceSkus = baseProducts
    .filter((item) => {
      const designLink = firstDefinedProperty(item.propertiesMap, ["_tib_design_link_1"]);
      return !isValidHttpUrl(designLink);
    })
    .map((item) => productSku(item.product) || normalizeText(item.product.name) || "unknown");

  const invalidPreviewSkus = baseProducts
    .filter((item) => {
      const preview = firstDefinedProperty(item.propertiesMap, ["_customization_image"]);
      return Boolean(preview) && !isValidHttpUrl(preview);
    })
    .map((item) => productSku(item.product) || normalizeText(item.product.name) || "unknown");

  if (asInteger(order.status_id) !== MATERIALS_STATUS_ID) {
    risks.push({
      severity: "info",
      code: "status_not_materials",
      message: `Order status is ${order.status_id ?? "unknown"}, so webhook flow will skip it until it reaches ${MATERIALS_STATUS_ID}.`,
    });
  }

  if (topLevelAddons.length > 0) {
    risks.push({
      severity: "warning",
      code: "top_level_addons",
      message: `Top-level add-ons detected without _parentKey: ${topLevelAddons.join(", ")}.`,
    });
  }

  if (alternativeParentKeys.length > 0) {
    risks.push({
      severity: "warning",
      code: "alternative_parent_keys",
      message: `Detected non-standard parent links: ${alternativeParentKeys.join(", ")}.`,
    });
  }

  if (missingDesignSourceSkus.length > 0) {
    risks.push({
      severity: "critical",
      code: "missing_design_source",
      message: `No valid design/source file found for: ${missingDesignSourceSkus.join(", ")}.`,
    });
  }

  if (invalidPreviewSkus.length > 0) {
    risks.push({
      severity: "warning",
      code: "invalid_preview_url",
      message: `Invalid _customization_image preview URL detected for: ${invalidPreviewSkus.join(", ")}.`,
    });
  }

  if (plan.qr.requested && !plan.qr.valid) {
    risks.push({
      severity: "warning",
      code: "invalid_qr_url",
      message: "QR was requested, but the URL is missing or invalid.",
    });
  }

  if (plan.qr.requested) {
    const nonWhitelisted = qrOutcomes.filter((item) => item.endsWith("sku_not_whitelisted"));
    if (nonWhitelisted.length > 0) {
      risks.push({
        severity: "info",
        code: "qr_not_embedded",
        message: `QR option exists, but SKU is outside the embed whitelist: ${nonWhitelisted.join(", ")}.`,
      });
    }
  }

  if (plan.materials.filter((material) => material.type === "poster").length > 1) {
    risks.push({
      severity: "info",
      code: "multi_poster_order",
      message: "Order contains multiple base posters and should stay in the regression set.",
    });
  }

  if (plan.flags.includes("A6 +") || plan.flags.includes("B +")) {
    risks.push({
      severity: "info",
      code: "manual_materials",
      message: "A6/keychain are counted in total numbering but require manual file preparation.",
    });
  }

  if (plan.notes.some((note) => note.includes("текст відсутній"))) {
    risks.push({
      severity: "warning",
      code: "missing_addon_text",
      message: "Engraving/sticker text is missing, so part of the ordered file set was skipped.",
    });
  }

  if (plan.notes.some((note) => note.includes("_customization_image невалідний"))) {
    risks.push({
      severity: "warning",
      code: "preview_missing",
      message: "Preview image was not added because _customization_image is invalid.",
    });
  }

  if (plan.notes.some((note) => note.includes("не прив'язана") || note.includes("нестандартний ключ прив"))) {
    risks.push({
      severity: "warning",
      code: "unlinked_addon",
      message: "At least one add-on was not linked to a base poster and needs manual verification.",
    });
  }

  return {
    orderId: String(order.id),
    scenario,
    statusId: asInteger(order.status_id),
    sourceId: asInteger(order.source_id),
    productCount: Array.isArray(order.products) ? order.products.length : 0,
    autoMaterials: plan.materials.length,
    totalMaterials: plan.materials[0]?.total ?? plan.materials.length,
    flags: plan.flags,
    notes: plan.notes,
    filenames: plan.materials.map((material) => material.filename),
    qrOutcomes,
    risks,
  };
}

function printHumanReport(reports: OrderReport[]): void {
  const counts = {
    critical: 0,
    warning: 0,
    info: 0,
  };

  for (const report of reports) {
    for (const risk of report.risks) {
      counts[risk.severity] += 1;
    }
  }

  process.stdout.write(`Business Logic Dry Run\n`);
  process.stdout.write(`Regression order set: ${reports.map((report) => report.orderId).join(", ")}\n`);
  process.stdout.write(
    `Risk totals: critical=${counts.critical}, warning=${counts.warning}, info=${counts.info}\n\n`,
  );

  for (const report of reports) {
    process.stdout.write(`[${report.orderId}] ${report.scenario}\n`);
    process.stdout.write(
      `status=${report.statusId ?? "unknown"} source=${report.sourceId ?? "unknown"} products=${report.productCount} auto=${report.autoMaterials} total=${report.totalMaterials}\n`,
    );
    process.stdout.write(
      `flags=${report.flags.length > 0 ? report.flags.join(", ") : "-"} notes=${report.notes.length > 0 ? report.notes.join(" | ") : "-"}\n`,
    );
    process.stdout.write(`files=${report.filenames.join(", ")}\n`);
    process.stdout.write(`qr=${report.qrOutcomes.length > 0 ? report.qrOutcomes.join("; ") : "-"}\n`);

    if (report.risks.length === 0) {
      process.stdout.write(`risks=none\n\n`);
      continue;
    }

    process.stdout.write(`risks:\n`);
    for (const risk of report.risks) {
      process.stdout.write(`- ${formatRisk(risk)}\n`);
    }
    process.stdout.write(`\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const testSet = await loadTestOrderSet(args.testSetPath);
  const orderIds = args.orderIds.length > 0 ? args.orderIds : normalizeOrderIds(testSet.orderIds ?? []);

  if (orderIds.length === 0) {
    throw new Error("No order IDs were provided.");
  }

  const apiBase = normalizeText(process.env.KEYCRM_API_BASE);
  const token = normalizeText(process.env.KEYCRM_TOKEN);
  if (!apiBase || !token) {
    throw new Error("KEYCRM_API_BASE and KEYCRM_TOKEN must be set.");
  }

  const productCodeRules = await loadProductCodeRules(
    path.resolve(process.cwd(), "config/business-rules/product-code-rules.json"),
  );
  const qrRules = await loadQrRules(path.resolve(process.cwd(), "config/business-rules/qr-rules.json"));
  const builder = new LayoutPlanBuilder(productCodeRules);

  const crmClient = new CrmClient({
    apiBase,
    token,
    orderInclude: parseCsv(process.env.KEYCRM_ORDER_INCLUDE),
    requestTimeoutMs: parsePositiveInteger(process.env.KEYCRM_REQUEST_TIMEOUT_MS, 15_000),
    retries: parsePositiveInteger(process.env.KEYCRM_REQUEST_RETRIES, 2),
    retryBaseMs: parsePositiveInteger(process.env.KEYCRM_REQUEST_RETRY_BASE_MS, 500),
    logger: createSilentLogger(),
  });

  const reports: OrderReport[] = [];
  for (const orderId of orderIds) {
    const order = await crmClient.getOrder(orderId);
    const scenario = testSet.scenarios?.[orderId] || "Unlabeled regression order";
    const enriched = enrichProducts(order);
    reports.push(createReport(order, scenario, builder, enriched, qrRules));
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    return;
  }

  printHumanReport(reports);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
