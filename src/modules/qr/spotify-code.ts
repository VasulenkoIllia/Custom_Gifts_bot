import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import type { QrPlacement } from "./qr-rules";

export type SpotifyRequestOptions = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
};

const DEFAULT_SPOTIFY_REQUEST_OPTIONS: SpotifyRequestOptions = {
  timeoutMs: 12_000,
  retries: 2,
  retryBaseMs: 700,
};

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function parseSpotifyUriFromOpenUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "open.spotify.com") {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    const allowedTypes = new Set(["track", "album", "playlist", "artist", "show", "episode"]);

    for (let index = 0; index < segments.length - 1; index += 1) {
      const type = segments[index];
      const id = segments[index + 1];
      if (!type || !id || !allowedTypes.has(type)) {
        continue;
      }

      return `spotify:${type}:${id}`;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

function normalizeHexColor(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
  if (/^[0-9A-F]{6}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeRequestOptions(options?: Partial<SpotifyRequestOptions>): SpotifyRequestOptions {
  const timeoutMs = Number.parseInt(String(options?.timeoutMs ?? DEFAULT_SPOTIFY_REQUEST_OPTIONS.timeoutMs), 10);
  const retries = Number.parseInt(String(options?.retries ?? DEFAULT_SPOTIFY_REQUEST_OPTIONS.retries), 10);
  const retryBaseMs = Number.parseInt(
    String(options?.retryBaseMs ?? DEFAULT_SPOTIFY_REQUEST_OPTIONS.retryBaseMs),
    10,
  );

  return {
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : DEFAULT_SPOTIFY_REQUEST_OPTIONS.timeoutMs,
    retries: Number.isFinite(retries) ? Math.max(0, Math.min(6, retries)) : DEFAULT_SPOTIFY_REQUEST_OPTIONS.retries,
    retryBaseMs: Number.isFinite(retryBaseMs)
      ? Math.max(100, Math.min(20_000, retryBaseMs))
      : DEFAULT_SPOTIFY_REQUEST_OPTIONS.retryBaseMs,
  };
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  const source = error instanceof Error ? error.message : String(error ?? "");
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(
    source.toLowerCase(),
  );
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(String(value).trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function computeBackoffDelayMs(attempt: number, retryBaseMs: number, maxDelayMs = 20_000): number {
  const safeAttempt = Math.max(1, attempt);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = retryBaseMs * (2 ** cappedExp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, retryBaseMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function createSpotifyError(params: {
  operation: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  code?: string;
}): Error {
  const error = new Error(`Spotify ${params.operation} failed: ${params.message}`) as Error & {
    retryable?: boolean;
    statusCode?: number;
    code?: string;
    service?: string;
    operation?: string;
  };
  error.name = "SpotifyServiceError";
  error.retryable = params.retryable;
  error.statusCode = params.statusCode;
  error.code = params.code;
  error.service = "spotify";
  error.operation = params.operation;
  return error;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestSpotifyText(params: {
  operation: "resolve_short_link" | "download_scannable_svg";
  url: string;
  requestOptions?: Partial<SpotifyRequestOptions>;
  redirect?: RequestRedirect;
}): Promise<{ response: Response; text: string }> {
  const requestOptions = normalizeRequestOptions(params.requestOptions);
  const maxAttempts = requestOptions.retries + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        params.url,
        {
          method: "GET",
          redirect: params.redirect ?? "follow",
        },
        requestOptions.timeoutMs,
      );

      const text = await response.text();
      if (response.ok) {
        return { response, text };
      }

      const retryable = isRetryableStatusCode(response.status);
      if (retryable && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, requestOptions.retryBaseMs);
        await sleep(delayMs);
        continue;
      }

      throw createSpotifyError({
        operation: params.operation,
        message: `HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        statusCode: response.status,
        retryable,
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableFetchError(error)) {
        await sleep(computeBackoffDelayMs(attempt, requestOptions.retryBaseMs));
        continue;
      }

      if (error instanceof Error && (error as { retryable?: unknown }).retryable !== undefined) {
        throw error;
      }

      throw createSpotifyError({
        operation: params.operation,
        message: error instanceof Error ? error.message : String(error),
        retryable: isRetryableFetchError(error),
        code:
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : undefined,
      });
    }
  }

  throw createSpotifyError({
    operation: params.operation,
    message: lastError instanceof Error ? lastError.message : "Unknown Spotify request failure",
    retryable: isRetryableFetchError(lastError),
  });
}

async function resolveRedirectedUrl(url: string, requestOptions?: Partial<SpotifyRequestOptions>): Promise<string> {
  const { response } = await requestSpotifyText({
    operation: "resolve_short_link",
    url,
    requestOptions,
    redirect: "follow",
  });

  return response.url;
}

export async function resolveSpotifyUri(
  value: string,
  requestOptions?: Partial<SpotifyRequestOptions>,
): Promise<string> {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("Spotify URL is empty.");
  }

  if (text.toLowerCase().startsWith("spotify:")) {
    return text;
  }

  const direct = parseSpotifyUriFromOpenUrl(text);
  if (direct) {
    return direct;
  }

  const isShort = (() => {
    try {
      const parsed = new URL(text);
      const host = parsed.hostname.toLowerCase();
      return host === "spotify.link" || host === "spoti.fi";
    } catch (_error) {
      return false;
    }
  })();

  if (!isShort) {
    throw new Error("URL is not a supported Spotify link.");
  }

  const redirected = await resolveRedirectedUrl(text, requestOptions);
  const uri = parseSpotifyUriFromOpenUrl(redirected);
  if (!uri) {
    throw new Error("Spotify short URL did not resolve to open.spotify.com URI.");
  }

  return uri;
}

function buildSpotifyScannableSvgUrl(spotifyUri: string): string {
  // Request a deterministic SVG variant, then recolor and remove background locally.
  return `https://scannables.scdn.co/uri/plain/svg/000000/white/640/${encodeURIComponent(
    spotifyUri,
  )}`;
}

async function downloadSpotifyCodeSvg(params: {
  spotifyUri: string;
  requestOptions?: Partial<SpotifyRequestOptions>;
}): Promise<string> {
  const url = buildSpotifyScannableSvgUrl(params.spotifyUri);
  const { text } = await requestSpotifyText({
    operation: "download_scannable_svg",
    url,
    requestOptions: params.requestOptions,
  });

  if (!text.trim()) {
    throw createSpotifyError({
      operation: "download_scannable_svg",
      message: "empty SVG payload",
      retryable: true,
    });
  }

  return text;
}

export function sanitizeSpotifyScannableSvg(svgSource: string, codeHex: string): string {
  const normalizedCodeHex = normalizeHexColor(codeHex, "FFFEFA");
  const source = String(svgSource ?? "").trim();
  if (!source) {
    throw new Error("Spotify SVG is empty.");
  }

  // Spotify scannable SVG includes background as first rect under <svg>.
  let output = source.replace(/(<svg\b[^>]*>\s*)<rect\b[^>]*\/>\s*/i, "$1");
  output = output.replace(/(<svg\b[^>]*>\s*)<rect\b[^>]*>\s*<\/rect>\s*/i, "$1");

  output = output.replace(/\bfill="#ffffff"/gi, `fill="#${normalizedCodeHex}"`);
  output = output.replace(/\bfill="white"/gi, `fill="#${normalizedCodeHex}"`);

  return output;
}

async function rasterizeSpotifySvgToPng(svgSource: string, targetWidthPx: number): Promise<Buffer> {
  return await sharp(Buffer.from(svgSource, "utf8"))
    .resize(targetWidthPx)
    .png()
    .toBuffer();
}

export async function embedSpotifyCodeIntoPosterPdf(params: {
  posterPdfPath: string;
  spotifyUri: string;
  placement: QrPlacement;
  backgroundHex?: string;
  codeHex?: string;
  requestOptions?: Partial<SpotifyRequestOptions>;
}): Promise<void> {
  const pdfBytes = await fs.readFile(params.posterPdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error("Poster PDF has no pages.");
  }

  const codeHex = normalizeHexColor(params.codeHex ?? "FFFEFA", "FFFEFA");
  const svgSource = await downloadSpotifyCodeSvg({
    spotifyUri: params.spotifyUri,
    requestOptions: params.requestOptions,
  });
  const sanitizedSvg = sanitizeSpotifyScannableSvg(svgSource, codeHex);
  // Render at 600 DPI equivalent for the target physical size to avoid upscaling artifacts.
  const targetWidthPx = Math.ceil((params.placement.widthMm / 25.4) * 600);
  const imageBytes = await rasterizeSpotifySvgToPng(sanitizedSvg, targetWidthPx);
  const image = await pdfDoc.embedPng(imageBytes);

  const widthPt = mmToPt(params.placement.widthMm);
  const heightPt = mmToPt(params.placement.heightMm);
  const bottomPt = mmToPt(params.placement.bottomMm);

  for (const page of pages) {
    const pageWidth = page.getWidth();
    const xPt =
      params.placement.mode === "bottom_center"
        ? (pageWidth - widthPt) / 2
        : pageWidth - mmToPt(params.placement.rightMm ?? 0) - widthPt;
    if (
      !Number.isFinite(xPt) ||
      !Number.isFinite(bottomPt) ||
      xPt < 0 ||
      bottomPt < 0 ||
      xPt + widthPt > pageWidth ||
      bottomPt + heightPt > page.getHeight()
    ) {
      throw new Error("Computed Spotify placement is out of page bounds.");
    }

    page.drawImage(image, {
      x: xPt,
      y: bottomPt,
      width: widthPt,
      height: heightPt,
    });
  }

  const nextBytes = await pdfDoc.save();
  await fs.writeFile(params.posterPdfPath, nextBytes);
}
