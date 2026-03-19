import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import type { QrPlacement } from "./qr-rules";

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

async function resolveRedirectedUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Cannot resolve Spotify short link: ${response.status}`);
  }

  return response.url;
}

export async function resolveSpotifyUri(value: string): Promise<string> {
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

  const redirected = await resolveRedirectedUrl(text);
  const uri = parseSpotifyUriFromOpenUrl(redirected);
  if (!uri) {
    throw new Error("Spotify short URL did not resolve to open.spotify.com URI.");
  }

  return uri;
}

function buildSpotifyScannablePngUrl(
  spotifyUri: string,
  backgroundHex: string,
  codeHex: string,
): string {
  return `https://scannables.scdn.co/uri/plain/png/${backgroundHex}/${codeHex}/640/${encodeURIComponent(
    spotifyUri,
  )}`;
}

async function downloadSpotifyCodeImage(params: {
  spotifyUri: string;
  backgroundHex: string;
  codeHex: string;
}): Promise<Buffer> {
  const url = buildSpotifyScannablePngUrl(params.spotifyUri, params.backgroundHex, params.codeHex);
  const response = await fetch(url, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Spotify scannable fetch failed: ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

export async function embedSpotifyCodeIntoPosterPdf(params: {
  posterPdfPath: string;
  spotifyUri: string;
  placement: QrPlacement;
  backgroundHex?: string;
  codeHex?: string;
}): Promise<void> {
  const pdfBytes = await fs.readFile(params.posterPdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error("Poster PDF has no pages.");
  }

  const backgroundHex = normalizeHexColor(params.backgroundHex ?? "FFFEFA", "FFFEFA");
  const codeHex = normalizeHexColor(params.codeHex ?? "000000", "000000");
  const imageBytes = await downloadSpotifyCodeImage({
    spotifyUri: params.spotifyUri,
    backgroundHex,
    codeHex,
  });
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
