import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import * as QRCode from "qrcode";
import type { QrPlacement } from "./qr-rules";

const QR_PNG_CACHE_MAX_ENTRIES = 128;
const qrPngCache = new Map<string, Buffer>();

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function normalizeHexColor(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();

  if (/^[0-9A-F]{6}$/.test(normalized)) {
    return normalized;
  }

  return "FFFEFA";
}

function placementToCoordinates(params: {
  placement: QrPlacement;
  pageWidthPt: number;
  pageHeightPt: number;
}): { xPt: number; yPt: number; widthPt: number; heightPt: number } {
  const widthPt = mmToPt(params.placement.widthMm);
  const heightPt = mmToPt(params.placement.heightMm);
  const yPt = mmToPt(params.placement.bottomMm);

  const xPt =
    params.placement.mode === "bottom_center"
      ? (params.pageWidthPt - widthPt) / 2
      : params.pageWidthPt - mmToPt(params.placement.rightMm ?? 0) - widthPt;

  if (
    !Number.isFinite(xPt) ||
    !Number.isFinite(yPt) ||
    xPt < 0 ||
    yPt < 0 ||
    xPt + widthPt > params.pageWidthPt ||
    yPt + heightPt > params.pageHeightPt
  ) {
    throw new Error("Computed QR placement is out of page bounds.");
  }

  return {
    xPt,
    yPt,
    widthPt,
    heightPt,
  };
}

function readQrPngCache(cacheKey: string): Buffer | null {
  const cached = qrPngCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  qrPngCache.delete(cacheKey);
  qrPngCache.set(cacheKey, cached);
  return cached;
}

function writeQrPngCache(cacheKey: string, imageBytes: Buffer): void {
  qrPngCache.set(cacheKey, imageBytes);
  while (qrPngCache.size > QR_PNG_CACHE_MAX_ENTRIES) {
    const oldestKey = qrPngCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    qrPngCache.delete(oldestKey);
  }
}

async function loadQrPng(params: {
  qrUrl: string;
  darkHex: string;
  qrSizePx: number;
}): Promise<Buffer> {
  const cacheKey = [params.qrUrl, params.darkHex, params.qrSizePx].join("|");
  const cached = readQrPngCache(cacheKey);
  if (cached) {
    return cached;
  }

  const imageBytes = await QRCode.toBuffer(params.qrUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: params.qrSizePx,
    color: {
      dark: `#${params.darkHex}`,
      light: "#0000",
    },
  });
  writeQrPngCache(cacheKey, imageBytes);
  return imageBytes;
}

export async function embedQrIntoPosterPdf(params: {
  posterPdfPath: string;
  qrUrl: string;
  placement: QrPlacement;
  qrHex?: string;
}): Promise<void> {
  const pdfBytes = await fs.readFile(params.posterPdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPages()[0];

  if (!page) {
    throw new Error("Poster PDF has no pages.");
  }

  const darkHex = normalizeHexColor(params.qrHex ?? "FFFEFA");
  // Render at 600 DPI equivalent for the target physical size to avoid upscaling artifacts.
  const qrSizePx = Math.ceil((params.placement.widthMm / 25.4) * 600);
  const qrPng = await loadQrPng({
    qrUrl: params.qrUrl,
    darkHex,
    qrSizePx,
  });

  const image = await pdfDoc.embedPng(qrPng);
  const { xPt, yPt, widthPt, heightPt } = placementToCoordinates({
    placement: params.placement,
    pageWidthPt: page.getWidth(),
    pageHeightPt: page.getHeight(),
  });

  page.drawImage(image, {
    x: xPt,
    y: yPt,
    width: widthPt,
    height: heightPt,
  });

  const nextBytes = await pdfDoc.save();
  await fs.writeFile(params.posterPdfPath, nextBytes);
}
