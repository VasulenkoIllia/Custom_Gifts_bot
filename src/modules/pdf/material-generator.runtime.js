"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const QRCode = require("qrcode");
const { PNG } = require("pngjs");

const A3_WIDTH_MM = 297;
const A3_HEIGHT_MM = 420;
const DEFAULT_STICKER_SIZE_MM = 100;
const DEFAULT_FONT_SIZE = 28;
const MIN_FONT_SIZE = 4;
const MAX_PADDING_MM = 5;
const MIN_PADDING_MM = 1.5;
const DEFAULT_SOURCE_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SOURCE_REQUEST_RETRIES = 2;
const DEFAULT_SOURCE_REQUEST_RETRY_BASE_MS = 800;
const DEFAULT_EMOJI_REQUEST_TIMEOUT_MS = 10_000;

const ENGRAVING_ZONE_BY_FORMAT = {
  A5: { widthMm: 148, heightMm: 22 },
  A4: { widthMm: 210, heightMm: 22 },
};

const mmToPt = (mm) => (mm * 72) / 25.4;

let ghostscriptVersionPromise = null;

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeSourceRequestOptions(sourceRequestOptions = {}) {
  const timeoutMs = Number.parseInt(
    String(sourceRequestOptions.timeoutMs ?? DEFAULT_SOURCE_REQUEST_TIMEOUT_MS),
    10,
  );
  const retries = Number.parseInt(
    String(sourceRequestOptions.retries ?? DEFAULT_SOURCE_REQUEST_RETRIES),
    10,
  );
  const retryBaseMs = Number.parseInt(
    String(sourceRequestOptions.retryBaseMs ?? DEFAULT_SOURCE_REQUEST_RETRY_BASE_MS),
    10,
  );

  return {
    timeoutMs: Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.min(120_000, timeoutMs))
      : DEFAULT_SOURCE_REQUEST_TIMEOUT_MS,
    retries: Number.isFinite(retries)
      ? Math.max(0, Math.min(6, retries))
      : DEFAULT_SOURCE_REQUEST_RETRIES,
    retryBaseMs: Number.isFinite(retryBaseMs)
      ? Math.max(100, Math.min(20_000, retryBaseMs))
      : DEFAULT_SOURCE_REQUEST_RETRY_BASE_MS,
  };
}

function computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs = 20_000) {
  const safeAttempt = Math.max(1, Number.parseInt(String(attempt), 10) || 1);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = baseDelayMs * (2 ** cappedExp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function isRetryableStatusCode(statusCode) {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const seconds = Number.parseInt(String(value).trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = Date.parse(String(value));
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function isRetryableFetchError(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  const message = String(error.message ?? "").toLowerCase();
  return /fetch failed|network|timeout|socket|econnreset|etimedout|econnrefused|enotfound|eai_again/i.test(
    message,
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeColorSpace(colorSpace) {
  return String(colorSpace ?? "RGB").trim().toUpperCase() === "CMYK" ? "CMYK" : "RGB";
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
        return;
      }

      const output = `${stdout}\n${stderr}`.trim();
      reject(
        new Error(
          `${command} exited with code ${code}${output ? `: ${output.slice(0, 500)}` : ""}`,
        ),
      );
    });
  });
}

async function ensureGhostscriptAvailable() {
  if (!ghostscriptVersionPromise) {
    ghostscriptVersionPromise = runCommand("gs", ["--version"])
      .then((result) => result.stdout || "unknown")
      .catch((error) => {
        throw new Error(
          `Ghostscript (gs) is required for CMYK conversion. Install it and retry. Root error: ${error.message}`,
        );
      });
  }

  return ghostscriptVersionPromise;
}

async function convertPdfToCmykInPlace(filePath) {
  const tempFilePath = `${filePath}.cmyk.tmp.pdf`;

  try {
    await runCommand("gs", [
      "-q",
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dProcessColorModel=/DeviceCMYK",
      "-dColorConversionStrategy=/CMYK",
      "-dColorConversionStrategyForImages=/CMYK",
      "-dAutoRotatePages=/None",
      `-sOutputFile=${tempFilePath}`,
      filePath,
    ]);

    await fsp.rename(tempFilePath, filePath);
  } catch (error) {
    await fsp.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

function parseHexColor(hex) {
  const normalized = String(hex ?? "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();

  if (!/^[0-9a-f]{6}$/.test(normalized)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
    hex: normalized.toUpperCase(),
  };
}

async function rasterizePdfToPngs({ filePath, outputPattern, dpi }) {
  await runCommand("gs", [
    "-q",
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-sDEVICE=pngalpha",
    "-dTextAlphaBits=4",
    "-dGraphicsAlphaBits=4",
    `-r${dpi}`,
    `-sOutputFile=${outputPattern}`,
    filePath,
  ]);
}

function isNearWhitePixel({ red, green, blue, threshold, maxSaturation }) {
  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  if (minChannel < threshold) {
    return false;
  }

  if (maxChannel === 0) {
    return false;
  }

  const saturation = (maxChannel - minChannel) / maxChannel;
  return saturation <= maxSaturation;
}

function restoreUnpremultipliedChannel(value, alpha) {
  if (alpha <= 0 || alpha >= 255) {
    return value;
  }
  return Math.min(255, Math.round((value * 255) / alpha));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function srgbToLinear(channel) {
  const value = clamp(channel / 255, 0, 1);
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return ((value + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(red, green, blue) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);

  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

  const xN = 0.95047;
  const yN = 1.0;
  const zN = 1.08883;
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;

  const fx = x / xN > epsilon ? (x / xN) ** (1 / 3) : (kappa * (x / xN) + 16) / 116;
  const fy = y / yN > epsilon ? (y / yN) ** (1 / 3) : (kappa * (y / yN) + 16) / 116;
  const fz = z / zN > epsilon ? (z / zN) ** (1 / 3) : (kappa * (z / zN) + 16) / 116;

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function deltaEToPaperWhite(lab) {
  const dL = 100 - lab.l;
  return Math.sqrt(dL * dL + lab.a * lab.a + lab.b * lab.b);
}

function detectPremultipliedAlpha(png) {
  const pixelsCount = png.width * png.height;
  if (pixelsCount <= 0) {
    return false;
  }

  const maxSamples = 25_000;
  const step = Math.max(1, Math.floor(pixelsCount / maxSamples));
  let semiTransparent = 0;
  let likelyPremultiplied = 0;

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += step) {
    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha <= 0 || alpha >= 255) {
      continue;
    }

    const maxChannel = Math.max(
      png.data[dataIndex],
      png.data[dataIndex + 1],
      png.data[dataIndex + 2],
    );
    if (maxChannel <= alpha + 2) {
      likelyPremultiplied += 1;
    }
    semiTransparent += 1;
  }

  if (semiTransparent < 50) {
    return false;
  }

  return likelyPremultiplied / semiTransparent >= 0.9;
}

function boxBlurHorizontal(source, target, width, height, radius) {
  const kernelSize = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let sum = 0;

    for (let x = -radius; x <= radius; x += 1) {
      const sampleX = clamp(x, 0, width - 1);
      sum += source[rowOffset + sampleX];
    }

    for (let x = 0; x < width; x += 1) {
      target[rowOffset + x] = sum / kernelSize;
      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      sum += source[rowOffset + addX] - source[rowOffset + removeX];
    }
  }
}

function boxBlurVertical(source, target, width, height, radius) {
  const kernelSize = radius * 2 + 1;

  for (let x = 0; x < width; x += 1) {
    let sum = 0;

    for (let y = -radius; y <= radius; y += 1) {
      const sampleY = clamp(y, 0, height - 1);
      sum += source[sampleY * width + x];
    }

    for (let y = 0; y < height; y += 1) {
      target[y * width + x] = sum / kernelSize;
      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      sum += source[addY * width + x] - source[removeY * width + x];
    }
  }
}

function blurMaskInPlace(mask, width, height, radius) {
  if (radius <= 0) {
    return;
  }

  const temp = new Float32Array(mask.length);
  boxBlurHorizontal(mask, temp, width, height, radius);
  boxBlurVertical(temp, mask, width, height, radius);
}

function readWorkingRgb(data, dataIndex, alpha, premultiplied) {
  if (alpha <= 0) {
    return {
      red: 0,
      green: 0,
      blue: 0,
    };
  }

  if (!premultiplied || alpha >= 255) {
    return {
      red: data[dataIndex],
      green: data[dataIndex + 1],
      blue: data[dataIndex + 2],
    };
  }

  return {
    red: restoreUnpremultipliedChannel(data[dataIndex], alpha),
    green: restoreUnpremultipliedChannel(data[dataIndex + 1], alpha),
    blue: restoreUnpremultipliedChannel(data[dataIndex + 2], alpha),
  };
}

function writeWorkingRgb(data, dataIndex, alpha, premultiplied, red, green, blue) {
  const clampedRed = clamp(Math.round(red), 0, 255);
  const clampedGreen = clamp(Math.round(green), 0, 255);
  const clampedBlue = clamp(Math.round(blue), 0, 255);

  if (!premultiplied || alpha >= 255) {
    data[dataIndex] = clampedRed;
    data[dataIndex + 1] = clampedGreen;
    data[dataIndex + 2] = clampedBlue;
    return;
  }

  data[dataIndex] = Math.round((clampedRed * alpha) / 255);
  data[dataIndex + 1] = Math.round((clampedGreen * alpha) / 255);
  data[dataIndex + 2] = Math.round((clampedBlue * alpha) / 255);
}

function sanitizeTransparentRgbInPlace(png) {
  const pixelsCount = png.width * png.height;
  let zeroedPixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    if (png.data[dataIndex + 3] !== 0) {
      continue;
    }

    if (
      png.data[dataIndex] === 0 &&
      png.data[dataIndex + 1] === 0 &&
      png.data[dataIndex + 2] === 0
    ) {
      continue;
    }

    png.data[dataIndex] = 0;
    png.data[dataIndex + 1] = 0;
    png.data[dataIndex + 2] = 0;
    zeroedPixels += 1;
  }

  return zeroedPixels;
}

function buildThresholdWhiteMask({
  png,
  threshold,
  maxSaturation,
  minAlpha,
  premultiplied,
}) {
  const pixelsCount = png.width * png.height;
  const mask = new Float32Array(pixelsCount);

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha <= minAlpha) {
      continue;
    }

    const rgbPixel = readWorkingRgb(png.data, dataIndex, alpha, premultiplied);
    if (
      isNearWhitePixel({
        red: rgbPixel.red,
        green: rgbPixel.green,
        blue: rgbPixel.blue,
        threshold,
        maxSaturation,
      })
    ) {
      mask[pixelIndex] = 1;
    }
  }

  return mask;
}

function buildPhotoshopLikeWhiteMask({
  png,
  threshold,
  maxSaturation,
  minAlpha,
  labDeltaEMax,
  labSoftness,
  minLightness,
  premultiplied,
}) {
  const pixelsCount = png.width * png.height;
  const mask = new Float32Array(pixelsCount);
  const brightnessGate = Math.max(0, threshold);
  const deltaInner = Math.max(0, labDeltaEMax - labSoftness * 0.5);
  const deltaOuter = labDeltaEMax + labSoftness;
  const lightInner = Math.max(0, minLightness - labSoftness * 0.35);
  const lightOuter = Math.min(100, minLightness + labSoftness * 0.2);
  const saturationSoftness = Math.max(0.01, maxSaturation * 0.3);

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha <= minAlpha) {
      continue;
    }

    const rgbPixel = readWorkingRgb(png.data, dataIndex, alpha, premultiplied);
    const red = rgbPixel.red;
    const green = rgbPixel.green;
    const blue = rgbPixel.blue;
    const maxChannel = Math.max(red, green, blue);
    if (maxChannel < brightnessGate) {
      continue;
    }

    const minChannel = Math.min(red, green, blue);
    const saturation = maxChannel === 0 ? 0 : (maxChannel - minChannel) / maxChannel;
    if (saturation > maxSaturation + saturationSoftness) {
      continue;
    }

    const lab = rgbToLab(red, green, blue);
    const deltaE = deltaEToPaperWhite(lab);
    const deltaWeight = 1 - smoothstep(deltaInner, deltaOuter, deltaE);
    const lightWeight = smoothstep(lightInner, lightOuter, lab.l);
    const saturationWeight =
      1 - smoothstep(maxSaturation, maxSaturation + saturationSoftness, saturation);
    const maskWeight = deltaWeight * lightWeight * saturationWeight;

    if (maskWeight <= 0) {
      continue;
    }

    mask[pixelIndex] = clamp(maskWeight, 0, 1);
  }

  return mask;
}

function buildResidualWhiteCleanupMask({
  png,
  minAlpha,
  premultiplied,
  strictMinChannel = 248,
  strictMaxSaturation = 0.35,
}) {
  const pixelsCount = png.width * png.height;
  const mask = new Float32Array(pixelsCount);
  let candidatePixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha <= minAlpha) {
      continue;
    }

    const rgbPixel = readWorkingRgb(png.data, dataIndex, alpha, premultiplied);
    const maxChannel = Math.max(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
    const minChannel = Math.min(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
    const saturation = maxChannel === 0 ? 0 : (maxChannel - minChannel) / maxChannel;

    // 1) Aggressive catch for leftover near-pure whites.
    if (minChannel >= strictMinChannel && saturation <= strictMaxSaturation) {
      mask[pixelIndex] = 1;
      candidatePixels += 1;
      continue;
    }

    // 2) Tight Lab fallback for very bright neutral tones close to paper white.
    if (minChannel >= strictMinChannel - 6 && saturation <= 0.12) {
      const lab = rgbToLab(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
      const deltaE = deltaEToPaperWhite(lab);
      if (lab.l >= 96.8 && deltaE <= 12) {
        mask[pixelIndex] = 1;
        candidatePixels += 1;
      }
    }
  }

  return {
    mask,
    candidatePixels,
  };
}

function buildHardWhiteCleanupMask({
  png,
  minAlpha,
  premultiplied,
  hardMinChannel = 246,
  hardMinLightness = 98.5,
  hardDeltaEMax = 14,
  hardMaxSaturation = 0.6,
}) {
  const pixelsCount = png.width * png.height;
  const mask = new Float32Array(pixelsCount);
  let candidatePixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha <= minAlpha) {
      continue;
    }

    const rgbPixel = readWorkingRgb(png.data, dataIndex, alpha, premultiplied);
    const maxChannel = Math.max(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
    const minChannel = Math.min(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
    const saturation = maxChannel === 0 ? 0 : (maxChannel - minChannel) / maxChannel;

    // Hard neutral near-white gate: very aggressive for tiny leftovers.
    if (minChannel >= hardMinChannel) {
      mask[pixelIndex] = 1;
      candidatePixels += 1;
      continue;
    }

    // Lab fallback for bright near-white tones that miss channel gate by a few values.
    if (maxChannel < hardMinChannel + 4 || saturation > hardMaxSaturation) {
      continue;
    }

    const lab = rgbToLab(rgbPixel.red, rgbPixel.green, rgbPixel.blue);
    const deltaE = deltaEToPaperWhite(lab);
    if (lab.l >= hardMinLightness && deltaE <= hardDeltaEMax) {
      mask[pixelIndex] = 1;
      candidatePixels += 1;
    }
  }

  return {
    mask,
    candidatePixels,
  };
}

function fillMaskPinholes({ png, mask, minNeighborMask = 0.86, maxAlpha = 40, minNeighbors = 6 }) {
  const width = png.width;
  const height = png.height;
  const marks = new Uint8Array(mask.length);
  let filled = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixelIndex = y * width + x;
      if (mask[pixelIndex] >= minNeighborMask) {
        continue;
      }

      const alpha = png.data[pixelIndex * 4 + 3];
      if (alpha > maxAlpha) {
        continue;
      }

      let neighbors = 0;
      for (let ny = -1; ny <= 1; ny += 1) {
        for (let nx = -1; nx <= 1; nx += 1) {
          if (nx === 0 && ny === 0) {
            continue;
          }
          const neighborIndex = (y + ny) * width + (x + nx);
          if (mask[neighborIndex] >= minNeighborMask) {
            neighbors += 1;
          }
        }
      }

      if (neighbors >= minNeighbors) {
        marks[pixelIndex] = 1;
      }
    }
  }

  for (let pixelIndex = 0; pixelIndex < marks.length; pixelIndex += 1) {
    if (!marks[pixelIndex]) {
      continue;
    }
    mask[pixelIndex] = 1;
    filled += 1;
  }

  return filled;
}

function applyWhiteMaskToPng({
  png,
  mask,
  targetRgb,
  premultiplied,
  forceOpaqueOnStrongMask = false,
}) {
  const pixelsCount = png.width * png.height;
  let recoloredPixels = 0;
  let forcedOpaquePixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelsCount; pixelIndex += 1) {
    const weight = mask[pixelIndex];
    if (weight <= 0) {
      continue;
    }

    const dataIndex = pixelIndex * 4;
    const alpha = png.data[dataIndex + 3];
    if (alpha === 0) {
      continue;
    }

    const rgbPixel = readWorkingRgb(png.data, dataIndex, alpha, premultiplied);
    const nextRed = rgbPixel.red + (targetRgb.r - rgbPixel.red) * weight;
    const nextGreen = rgbPixel.green + (targetRgb.g - rgbPixel.green) * weight;
    const nextBlue = rgbPixel.blue + (targetRgb.b - rgbPixel.blue) * weight;

    writeWorkingRgb(png.data, dataIndex, alpha, premultiplied, nextRed, nextGreen, nextBlue);

    if (forceOpaqueOnStrongMask && weight >= 0.92 && alpha <= 40) {
      png.data[dataIndex + 3] = 255;
      writeWorkingRgb(
        png.data,
        dataIndex,
        255,
        premultiplied,
        targetRgb.r,
        targetRgb.g,
        targetRgb.b,
      );
      forcedOpaquePixels += 1;
    }

    recoloredPixels += 1;
  }

  return {
    recoloredPixels,
    forcedOpaquePixels,
  };
}

function recolorWhitePngInPlace({
  pngPath,
  targetRgb,
  threshold,
  maxSaturation,
  mode,
  labDeltaEMax,
  labSoftness,
  minLightness,
  featherPx,
  minAlpha,
  cleanupPasses = 1,
  cleanupMinChannel = 248,
  cleanupMaxSaturation = 0.35,
  hardCleanupPasses = 0,
  hardCleanupMinChannel = 246,
  hardCleanupMinLightness = 98.5,
  hardCleanupDeltaEMax = 14,
  hardCleanupMaxSaturation = 0.6,
  sanitizeTransparentRgb = true,
}) {
  const pngBuffer = fs.readFileSync(pngPath);
  const png = PNG.sync.read(pngBuffer);
  const premultiplied = detectPremultipliedAlpha(png);
  const safeMode = String(mode ?? "threshold").trim().toLowerCase();
  const safeFeatherPx = Number.isFinite(Number(featherPx)) ? Math.max(0, Number(featherPx)) : 0;
  const safeMinAlpha = Number.isFinite(Number(minAlpha))
    ? Math.max(0, Math.min(255, Number(minAlpha)))
    : 1;
  const safeCleanupPasses = Number.isFinite(Number(cleanupPasses))
    ? Math.max(0, Math.min(3, Math.floor(Number(cleanupPasses))))
    : 1;
  const safeCleanupMinChannel = Number.isFinite(Number(cleanupMinChannel))
    ? Math.max(0, Math.min(255, Math.round(Number(cleanupMinChannel))))
    : 252;
  const safeCleanupMaxSaturation = Number.isFinite(Number(cleanupMaxSaturation))
    ? Math.max(0, Math.min(1, Number(cleanupMaxSaturation)))
    : 0.25;
  const safeHardCleanupPasses = Number.isFinite(Number(hardCleanupPasses))
    ? Math.max(0, Math.min(5, Math.floor(Number(hardCleanupPasses))))
    : 0;
  const safeHardCleanupMinChannel = Number.isFinite(Number(hardCleanupMinChannel))
    ? Math.max(0, Math.min(255, Math.round(Number(hardCleanupMinChannel))))
    : 246;
  const safeHardCleanupMinLightness = Number.isFinite(Number(hardCleanupMinLightness))
    ? Math.max(0, Math.min(100, Number(hardCleanupMinLightness)))
    : 98.5;
  const safeHardCleanupDeltaEMax = Number.isFinite(Number(hardCleanupDeltaEMax))
    ? Math.max(0.1, Number(hardCleanupDeltaEMax))
    : 14;
  const safeHardCleanupMaxSaturation = Number.isFinite(Number(hardCleanupMaxSaturation))
    ? Math.max(0, Math.min(1, Number(hardCleanupMaxSaturation)))
    : 0.6;
  const safeSanitizeTransparentRgb = Boolean(sanitizeTransparentRgb);

  let selectedMask;
  if (safeMode === "photoshop_like") {
    selectedMask = buildPhotoshopLikeWhiteMask({
      png,
      threshold,
      maxSaturation,
      minAlpha: safeMinAlpha,
      labDeltaEMax,
      labSoftness,
      minLightness,
      premultiplied,
    });
  } else {
    selectedMask = buildThresholdWhiteMask({
      png,
      threshold,
      maxSaturation,
      minAlpha: safeMinAlpha,
      premultiplied,
    });
  }

  let filledHolePixels = fillMaskPinholes({
    png,
    mask: selectedMask,
  });

  if (safeMode === "photoshop_like" && safeFeatherPx > 0.34) {
    const blurRadius = Math.max(1, Math.round(safeFeatherPx));
    blurMaskInPlace(selectedMask, png.width, png.height, blurRadius);
    filledHolePixels += fillMaskPinholes({
      png,
      mask: selectedMask,
      minNeighborMask: 0.92,
      maxAlpha: 18,
      minNeighbors: 7,
    });
  }

  const recolorStats = applyWhiteMaskToPng({
    png,
    mask: selectedMask,
    targetRgb,
    premultiplied,
    forceOpaqueOnStrongMask: true,
  });

  let cleanupReplacedPixels = 0;
  let cleanupCandidatePixels = 0;
  let cleanupPassesUsed = 0;

  for (let passIndex = 0; passIndex < safeCleanupPasses; passIndex += 1) {
    const cleanup = buildResidualWhiteCleanupMask({
      png,
      minAlpha: safeMinAlpha,
      premultiplied,
      strictMinChannel: safeCleanupMinChannel,
      strictMaxSaturation: safeCleanupMaxSaturation,
    });
    if (cleanup.candidatePixels <= 0) {
      break;
    }

    const cleanupStats = applyWhiteMaskToPng({
      png,
      mask: cleanup.mask,
      targetRgb,
      premultiplied,
      forceOpaqueOnStrongMask: true,
    });

    cleanupCandidatePixels += cleanup.candidatePixels;
    cleanupReplacedPixels += cleanupStats.recoloredPixels;
    cleanupPassesUsed += 1;

    if (cleanupStats.recoloredPixels <= 0) {
      break;
    }
  }

  let hardCleanupReplacedPixels = 0;
  let hardCleanupCandidatePixels = 0;
  let hardCleanupPassesUsed = 0;

  for (let passIndex = 0; passIndex < safeHardCleanupPasses; passIndex += 1) {
    const hardCleanup = buildHardWhiteCleanupMask({
      png,
      minAlpha: safeMinAlpha,
      premultiplied,
      hardMinChannel: safeHardCleanupMinChannel,
      hardMinLightness: safeHardCleanupMinLightness,
      hardDeltaEMax: safeHardCleanupDeltaEMax,
      hardMaxSaturation: safeHardCleanupMaxSaturation,
    });
    if (hardCleanup.candidatePixels <= 0) {
      break;
    }

    const hardCleanupStats = applyWhiteMaskToPng({
      png,
      mask: hardCleanup.mask,
      targetRgb,
      premultiplied,
      forceOpaqueOnStrongMask: true,
    });

    hardCleanupCandidatePixels += hardCleanup.candidatePixels;
    hardCleanupReplacedPixels += hardCleanupStats.recoloredPixels;
    hardCleanupPassesUsed += 1;

    if (hardCleanupStats.recoloredPixels <= 0) {
      break;
    }
  }

  const zeroedTransparentPixels = safeSanitizeTransparentRgb
    ? sanitizeTransparentRgbInPlace(png)
    : 0;

  fs.writeFileSync(pngPath, PNG.sync.write(png));

  return {
    replacedPixels: recolorStats.recoloredPixels,
    filledHolePixels,
    forcedOpaquePixels: recolorStats.forcedOpaquePixels,
    cleanupPassesUsed,
    cleanupCandidatePixels,
    cleanupReplacedPixels,
    hardCleanupPassesUsed,
    hardCleanupCandidatePixels,
    hardCleanupReplacedPixels,
    zeroedTransparentPixels,
    mode: safeMode,
    premultiplied_input: premultiplied,
  };
}

async function rebuildPdfFromPngs({ sourcePdfPath, pngPaths, outputPdfPath }) {
  const sourceBytes = await fsp.readFile(sourcePdfPath);
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const sourcePages = sourceDoc.getPages();

  if (sourcePages.length !== pngPaths.length) {
    throw new Error(
      `Rasterization page count mismatch: source=${sourcePages.length}, png=${pngPaths.length}`,
    );
  }

  const outDoc = await PDFDocument.create();

  for (let index = 0; index < pngPaths.length; index += 1) {
    const page = sourcePages[index];
    const width = page.getWidth();
    const height = page.getHeight();
    const outPage = outDoc.addPage([width, height]);
    const pngBytes = await fsp.readFile(pngPaths[index]);
    const pngImage = await outDoc.embedPng(pngBytes);

    outPage.drawImage(pngImage, {
      x: 0,
      y: 0,
      width,
      height,
    });
  }

  const outBytes = await outDoc.save();
  await fsp.writeFile(outputPdfPath, outBytes);
}

function findNonTransparentBoundingBox(png) {
  const width = png.width;
  const height = png.height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = png.data[(y * width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function buildOpaqueCropPngBuffer({ sourcePng, bbox, premultiplied }) {
  const out = new PNG({
    width: bbox.width,
    height: bbox.height,
  });

  for (let y = 0; y < bbox.height; y += 1) {
    for (let x = 0; x < bbox.width; x += 1) {
      const sourceIndex = ((bbox.y + y) * sourcePng.width + (bbox.x + x)) * 4;
      const outIndex = (y * bbox.width + x) * 4;
      const alpha = sourcePng.data[sourceIndex + 3];

      if (alpha > 0) {
        const rgbPixel = readWorkingRgb(sourcePng.data, sourceIndex, alpha, premultiplied);
        out.data[outIndex] = rgbPixel.red;
        out.data[outIndex + 1] = rgbPixel.green;
        out.data[outIndex + 2] = rgbPixel.blue;
      } else {
        out.data[outIndex] = 0;
        out.data[outIndex + 1] = 0;
        out.data[outIndex + 2] = 0;
      }

      out.data[outIndex + 3] = 255;
    }
  }

  return PNG.sync.write(out);
}

function hasSignificantInternalTransparency({ png, bbox }) {
  const totalPixels = bbox.width * bbox.height;
  if (totalPixels <= 0) {
    return false;
  }

  let transparentPixels = 0;

  for (let y = bbox.y; y < bbox.y + bbox.height; y += 1) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha === 0) {
        transparentPixels += 1;
      }
    }
  }

  const ratio = transparentPixels / totalPixels;
  return transparentPixels > 1200 && ratio > 0.01;
}

async function rebuildPdfFromPngsWithoutSoftMask({
  sourcePdfPath,
  pngPaths,
  outputPdfPath,
  allowSoftMaskFallback = false,
}) {
  const sourceBytes = await fsp.readFile(sourcePdfPath);
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const sourcePages = sourceDoc.getPages();

  if (sourcePages.length !== pngPaths.length) {
    throw new Error(
      `Rasterization page count mismatch: source=${sourcePages.length}, png=${pngPaths.length}`,
    );
  }

  const outDoc = await PDFDocument.create();
  let opaqueCropPages = 0;
  let softMaskFallbackPages = 0;

  for (let index = 0; index < pngPaths.length; index += 1) {
    const sourcePage = sourcePages[index];
    const pageWidthPt = sourcePage.getWidth();
    const pageHeightPt = sourcePage.getHeight();
    const outPage = outDoc.addPage([pageWidthPt, pageHeightPt]);

    const pagePngBuffer = await fsp.readFile(pngPaths[index]);
    const pagePng = PNG.sync.read(pagePngBuffer);
    const premultiplied = detectPremultipliedAlpha(pagePng);
    const bbox = findNonTransparentBoundingBox(pagePng);
    if (!bbox) {
      continue;
    }

    // Keep alpha on pages with large transparent islands inside content bounds.
    // This avoids accidental background fill artifacts when a design has separate objects.
    if (allowSoftMaskFallback && hasSignificantInternalTransparency({ png: pagePng, bbox })) {
      const fullPageImage = await outDoc.embedPng(pagePngBuffer);
      outPage.drawImage(fullPageImage, {
        x: 0,
        y: 0,
        width: pageWidthPt,
        height: pageHeightPt,
      });
      softMaskFallbackPages += 1;
      continue;
    }

    const opaqueCropBytes = buildOpaqueCropPngBuffer({
      sourcePng: pagePng,
      bbox,
      premultiplied,
    });
    const cropImage = await outDoc.embedPng(opaqueCropBytes);

    const xPt = (bbox.x / pagePng.width) * pageWidthPt;
    const widthPt = (bbox.width / pagePng.width) * pageWidthPt;
    const heightPt = (bbox.height / pagePng.height) * pageHeightPt;
    const yPt = ((pagePng.height - (bbox.y + bbox.height)) / pagePng.height) * pageHeightPt;

    outPage.drawImage(cropImage, {
      x: xPt,
      y: yPt,
      width: widthPt,
      height: heightPt,
    });
    opaqueCropPages += 1;
  }

  const outBytes = await outDoc.save();
  await fsp.writeFile(outputPdfPath, outBytes);

  return {
    opaqueCropPages,
    softMaskFallbackPages,
  };
}

async function replaceWhiteInPdfWithOffWhiteInPlace({
  filePath,
  offWhiteHex = "FFFEFA",
  threshold = 245,
  maxSaturation = 0.12,
  dpi = 300,
  stripSoftMask = false,
  mode = "threshold",
  labDeltaEMax = 20,
  labSoftness = 8,
  minLightness = 87,
  featherPx = 0.8,
  minAlpha = 0,
  cleanupPasses = 1,
  cleanupMinChannel = 248,
  cleanupMaxSaturation = 0.35,
  hardCleanupPasses = 0,
  hardCleanupMinChannel = 246,
  hardCleanupMinLightness = 98.5,
  hardCleanupDeltaEMax = 14,
  hardCleanupMaxSaturation = 0.6,
  sanitizeTransparentRgb = true,
  allowSoftMaskFallback = false,
}) {
  await ensureGhostscriptAvailable();

  const targetRgb = parseHexColor(offWhiteHex);
  const safeThreshold = Number.isFinite(Number(threshold))
    ? Math.max(0, Math.min(255, Number(threshold)))
    : 245;
  const safeMaxSaturation = Number.isFinite(Number(maxSaturation))
    ? Math.max(0, Math.min(1, Number(maxSaturation)))
    : 0.12;
  const safeDpi = Number.isFinite(Number(dpi)) ? Math.max(72, Number(dpi)) : 300;
  const safeMode = String(mode ?? "threshold").trim().toLowerCase();
  const safeLabDeltaEMax = Number.isFinite(Number(labDeltaEMax))
    ? Math.max(0.1, Number(labDeltaEMax))
    : 20;
  const safeLabSoftness = Number.isFinite(Number(labSoftness))
    ? Math.max(0.01, Number(labSoftness))
    : 8;
  const safeMinLightness = Number.isFinite(Number(minLightness))
    ? Math.max(0, Math.min(100, Number(minLightness)))
    : 87;
  const safeFeatherPx = Number.isFinite(Number(featherPx))
    ? Math.max(0, Number(featherPx))
    : 0.8;
  const safeMinAlpha = Number.isFinite(Number(minAlpha))
    ? Math.max(0, Math.min(255, Number(minAlpha)))
    : 1;
  const safeCleanupPasses = Number.isFinite(Number(cleanupPasses))
    ? Math.max(0, Math.min(3, Math.floor(Number(cleanupPasses))))
    : 1;
  const safeCleanupMinChannel = Number.isFinite(Number(cleanupMinChannel))
    ? Math.max(0, Math.min(255, Math.round(Number(cleanupMinChannel))))
    : 248;
  const safeCleanupMaxSaturation = Number.isFinite(Number(cleanupMaxSaturation))
    ? Math.max(0, Math.min(1, Number(cleanupMaxSaturation)))
    : 0.35;
  const safeHardCleanupPasses = Number.isFinite(Number(hardCleanupPasses))
    ? Math.max(0, Math.min(5, Math.floor(Number(hardCleanupPasses))))
    : 0;
  const safeHardCleanupMinChannel = Number.isFinite(Number(hardCleanupMinChannel))
    ? Math.max(0, Math.min(255, Math.round(Number(hardCleanupMinChannel))))
    : 246;
  const safeHardCleanupMinLightness = Number.isFinite(Number(hardCleanupMinLightness))
    ? Math.max(0, Math.min(100, Number(hardCleanupMinLightness)))
    : 98.5;
  const safeHardCleanupDeltaEMax = Number.isFinite(Number(hardCleanupDeltaEMax))
    ? Math.max(0.1, Number(hardCleanupDeltaEMax))
    : 14;
  const safeHardCleanupMaxSaturation = Number.isFinite(Number(hardCleanupMaxSaturation))
    ? Math.max(0, Math.min(1, Number(hardCleanupMaxSaturation)))
    : 0.6;
  const safeSanitizeTransparentRgb = Boolean(sanitizeTransparentRgb);
  const safeAllowSoftMaskFallback = Boolean(allowSoftMaskFallback);

  const tempDir = path.join(
    path.dirname(filePath),
    `.tmp-white-recolor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const pngPattern = path.join(tempDir, "page-%04d.png");
  const outputPdfPath = `${filePath}.recolor.tmp.pdf`;

  await fsp.mkdir(tempDir, { recursive: true });

  try {
    await rasterizePdfToPngs({
      filePath,
      outputPattern: pngPattern,
      dpi: safeDpi,
    });

    const pngFiles = (await fsp.readdir(tempDir))
      .filter((fileName) => fileName.toLowerCase().endsWith(".png"))
      .sort((left, right) => left.localeCompare(right))
      .map((fileName) => path.join(tempDir, fileName));

    if (pngFiles.length === 0) {
      throw new Error("Rasterization produced no pages.");
    }

    let replacedPixels = 0;
    let filledHolePixels = 0;
    let forcedOpaquePixels = 0;
    let premultipliedPages = 0;
    let cleanupPassesUsed = 0;
    let cleanupCandidatePixels = 0;
    let cleanupReplacedPixels = 0;
    let hardCleanupPassesUsed = 0;
    let hardCleanupCandidatePixels = 0;
    let hardCleanupReplacedPixels = 0;
    let zeroedTransparentPixels = 0;
    for (const pngPath of pngFiles) {
      const stats = recolorWhitePngInPlace({
        pngPath,
        targetRgb,
        threshold: safeThreshold,
        maxSaturation: safeMaxSaturation,
        mode: safeMode,
        labDeltaEMax: safeLabDeltaEMax,
        labSoftness: safeLabSoftness,
        minLightness: safeMinLightness,
        featherPx: safeFeatherPx,
        minAlpha: safeMinAlpha,
        cleanupPasses: safeCleanupPasses,
        cleanupMinChannel: safeCleanupMinChannel,
        cleanupMaxSaturation: safeCleanupMaxSaturation,
        hardCleanupPasses: safeHardCleanupPasses,
        hardCleanupMinChannel: safeHardCleanupMinChannel,
        hardCleanupMinLightness: safeHardCleanupMinLightness,
        hardCleanupDeltaEMax: safeHardCleanupDeltaEMax,
        hardCleanupMaxSaturation: safeHardCleanupMaxSaturation,
        sanitizeTransparentRgb: safeSanitizeTransparentRgb,
      });
      replacedPixels += stats.replacedPixels;
      filledHolePixels += stats.filledHolePixels;
      forcedOpaquePixels += stats.forcedOpaquePixels;
      cleanupPassesUsed += stats.cleanupPassesUsed;
      cleanupCandidatePixels += stats.cleanupCandidatePixels;
      cleanupReplacedPixels += stats.cleanupReplacedPixels;
      hardCleanupPassesUsed += stats.hardCleanupPassesUsed;
      hardCleanupCandidatePixels += stats.hardCleanupCandidatePixels;
      hardCleanupReplacedPixels += stats.hardCleanupReplacedPixels;
      zeroedTransparentPixels += stats.zeroedTransparentPixels;
      if (stats.premultiplied_input) {
        premultipliedPages += 1;
      }
    }

    let stripSoftMaskApplied = false;
    let softMaskFallbackPages = 0;
    let opaqueCropPages = 0;

    if (stripSoftMask) {
      const rebuildStats = await rebuildPdfFromPngsWithoutSoftMask({
        sourcePdfPath: filePath,
        pngPaths: pngFiles,
        outputPdfPath,
        allowSoftMaskFallback: safeAllowSoftMaskFallback,
      });
      stripSoftMaskApplied = (rebuildStats?.opaqueCropPages ?? 0) > 0 && (rebuildStats?.softMaskFallbackPages ?? 0) === 0;
      softMaskFallbackPages = rebuildStats?.softMaskFallbackPages ?? 0;
      opaqueCropPages = rebuildStats?.opaqueCropPages ?? 0;
    } else {
      await rebuildPdfFromPngs({
        sourcePdfPath: filePath,
        pngPaths: pngFiles,
        outputPdfPath,
      });
    }

    await fsp.rename(outputPdfPath, filePath);

    return {
      applied: true,
      target_hex: targetRgb.hex,
      threshold: safeThreshold,
      max_saturation: safeMaxSaturation,
      dpi: safeDpi,
      mode: safeMode,
      lab_delta_e_max: safeLabDeltaEMax,
      lab_softness: safeLabSoftness,
      min_lightness: safeMinLightness,
      feather_px: safeFeatherPx,
      min_alpha: safeMinAlpha,
      cleanup_passes: safeCleanupPasses,
      cleanup_min_channel: safeCleanupMinChannel,
      cleanup_max_saturation: safeCleanupMaxSaturation,
      hard_cleanup_passes: safeHardCleanupPasses,
      hard_cleanup_min_channel: safeHardCleanupMinChannel,
      hard_cleanup_min_lightness: safeHardCleanupMinLightness,
      hard_cleanup_delta_e_max: safeHardCleanupDeltaEMax,
      hard_cleanup_max_saturation: safeHardCleanupMaxSaturation,
      sanitize_transparent_rgb: safeSanitizeTransparentRgb,
      allow_soft_mask_fallback: safeAllowSoftMaskFallback,
      pages: pngFiles.length,
      replaced_pixels: replacedPixels,
      filled_hole_pixels: filledHolePixels,
      forced_opaque_pixels: forcedOpaquePixels,
      cleanup_passes_used: cleanupPassesUsed,
      cleanup_candidate_pixels: cleanupCandidatePixels,
      cleanup_replaced_pixels: cleanupReplacedPixels,
      hard_cleanup_passes_used: hardCleanupPassesUsed,
      hard_cleanup_candidate_pixels: hardCleanupCandidatePixels,
      hard_cleanup_replaced_pixels: hardCleanupReplacedPixels,
      zeroed_transparent_pixels: zeroedTransparentPixels,
      premultiplied_pages: premultipliedPages,
      strip_soft_mask_requested: Boolean(stripSoftMask),
      strip_soft_mask_applied: stripSoftMaskApplied,
      strip_soft_mask_opaque_pages: opaqueCropPages,
      strip_soft_mask_fallback_pages: softMaskFallbackPages,
    };
  } catch (error) {
    await fsp.rm(outputPdfPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function createFontSet(primary, fallbacks = []) {
  const normalizedFallbacks = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
  return {
    primary,
    fallbacks: normalizedFallbacks.filter(Boolean),
  };
}

function splitGraphemes(text) {
  const value = String(text ?? "");
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("uk", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (item) => item.segment);
  }
  return Array.from(value);
}

function isMissingGlyph(glyph) {
  return !glyph || glyph.id === 0 || glyph.name === ".notdef";
}

function hasDrawableGlyphOutline(glyph) {
  return (
    !isMissingGlyph(glyph) &&
    glyph.path &&
    glyph.path.commands &&
    glyph.path.commands.length
  );
}

function tryResolveRunWithFonts(fontSet, text) {
  const fonts = [fontSet.primary, ...fontSet.fallbacks];
  for (const font of fonts) {
    const run = font.layout(text);
    if (run.glyphs.some((glyph) => hasDrawableGlyphOutline(glyph))) {
      return {
        font,
        run,
        hasDrawableGlyph: true,
      };
    }
  }

  return {
    font: fontSet.primary,
    run: fontSet.primary.layout(text),
    hasDrawableGlyph: false,
  };
}

function normalizeEmojiCodepointHex(value) {
  return Number(value).toString(16).toLowerCase();
}

function emojiClusterToCodepointKeys(cluster) {
  const codepoints = Array.from(String(cluster ?? "")).map((char) =>
    normalizeEmojiCodepointHex(char.codePointAt(0)),
  );
  const withVs16 = codepoints.join("-");
  const withoutVs16 = codepoints.filter((codepoint) => codepoint !== "fe0f").join("-");

  if (withoutVs16 && withoutVs16 !== withVs16) {
    return [withVs16, withoutVs16];
  }

  return withVs16 ? [withVs16] : [];
}

async function resolveAppleEmojiPngBuffer(cluster, emojiRuntime, warnings) {
  if (!emojiRuntime || emojiRuntime.mode !== "apple_image") {
    return null;
  }

  const cacheKey = String(cluster ?? "");
  if (!cacheKey) {
    return null;
  }

  if (emojiRuntime.bytesCache.has(cacheKey)) {
    return emojiRuntime.bytesCache.get(cacheKey);
  }

  const codepointKeys = emojiClusterToCodepointKeys(cacheKey);

  for (const codepointKey of codepointKeys) {
    if (emojiRuntime.assetsDir) {
      const localPath = path.join(emojiRuntime.assetsDir, `${codepointKey}.png`);
      try {
        const bytes = await fsp.readFile(localPath);
        emojiRuntime.bytesCache.set(cacheKey, bytes);
        return bytes;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (emojiRuntime.baseUrl) {
      const url = `${emojiRuntime.baseUrl}/${codepointKey}.png`;
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: "GET",
          },
          DEFAULT_EMOJI_REQUEST_TIMEOUT_MS,
        );
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          emojiRuntime.bytesCache.set(cacheKey, bytes);
          return bytes;
        }
      } catch {
        // Network/source failures are handled by fallback + warning below.
      }
    }
  }

  emojiRuntime.bytesCache.set(cacheKey, null);
  if (!emojiRuntime.missingWarned.has(cacheKey)) {
    warnings.push(`Не вдалося завантажити Apple emoji для "${cacheKey}".`);
    emojiRuntime.missingWarned.add(cacheKey);
  }
  return null;
}

function resolveClusterRuns(fontSet, cluster, emojiRuntime) {
  const text = String(cluster ?? "");
  if (!text) {
    return [];
  }

  const candidateTexts = [text];
  if (text.includes("\uFE0F")) {
    const withoutVs16 = text.replace(/\uFE0F/g, "");
    if (withoutVs16 && withoutVs16 !== text) {
      candidateTexts.push(withoutVs16);
    }
  }

  for (const candidateText of candidateTexts) {
    const resolved = tryResolveRunWithFonts(fontSet, candidateText);
    if (resolved.hasDrawableGlyph) {
      return [{ kind: "run", ...resolved }];
    }
  }

  if (emojiRuntime?.mode === "apple_image" && containsEmoji(text)) {
    return [{ kind: "emoji", cluster: text }];
  }

  // Decompose unsupported grapheme clusters (ZWJ/VS16 sequences) to salvage renderable parts.
  const decomposed = Array.from(text).filter((char) => char !== "\uFE0F" && char !== "\u200D");
  if (decomposed.length > 1) {
    return decomposed.flatMap((part) => resolveClusterRuns(fontSet, part, emojiRuntime));
  }

  const fallback = tryResolveRunWithFonts(fontSet, "?");
  return [{ kind: "run", ...fallback }];
}

function getLineLayout(fontSet, text, fontSize, emojiRuntime = null) {
  const clusters = splitGraphemes(text);
  const segments = [];

  let penXPt = 0;
  let minXPt = Number.POSITIVE_INFINITY;
  let maxXPt = Number.NEGATIVE_INFINITY;

  for (const cluster of clusters) {
    const resolvedRuns = resolveClusterRuns(fontSet, cluster, emojiRuntime);
    for (const resolved of resolvedRuns) {
      if (resolved.kind === "emoji") {
        const emojiWidthPt = fontSize;
        const emojiStartXPt = penXPt;
        minXPt = Math.min(minXPt, emojiStartXPt);
        maxXPt = Math.max(maxXPt, emojiStartXPt + emojiWidthPt);
        segments.push({
          kind: "emoji",
          cluster: resolved.cluster,
          xPt: emojiStartXPt,
          widthPt: emojiWidthPt,
          heightPt: fontSize,
        });
        penXPt += emojiWidthPt;
        continue;
      }

      const runScale = fontSize / resolved.font.unitsPerEm;
      const runStartXPt = penXPt;
      let runPenUnits = 0;

      for (let index = 0; index < resolved.run.glyphs.length; index += 1) {
        const glyph = resolved.run.glyphs[index];
        const position = resolved.run.positions[index];
        if (hasDrawableGlyphOutline(glyph)) {
          const glyphMinXPt =
            runStartXPt + (runPenUnits + position.xOffset + glyph.bbox.minX) * runScale;
          const glyphMaxXPt =
            runStartXPt + (runPenUnits + position.xOffset + glyph.bbox.maxX) * runScale;
          minXPt = Math.min(minXPt, glyphMinXPt);
          maxXPt = Math.max(maxXPt, glyphMaxXPt);
        }
        runPenUnits += position.xAdvance;
      }

      segments.push({
        kind: "run",
        font: resolved.font,
        glyphs: resolved.run.glyphs,
        positions: resolved.run.positions,
        xPt: runStartXPt,
        scale: runScale,
      });

      penXPt += runPenUnits * runScale;
    }
  }

  if (!Number.isFinite(minXPt) || !Number.isFinite(maxXPt)) {
    minXPt = 0;
    maxXPt = penXPt;
  }

  return {
    segments,
    minX: minXPt,
    width: Math.max(0, maxXPt - minXPt),
  };
}

function getTextWidth(fontSet, text, fontSize, emojiRuntime = null) {
  return getLineLayout(fontSet, text, fontSize, emojiRuntime).width;
}

function glyphPathToSvg(glyph) {
  const commands = glyph.path && glyph.path.commands ? glyph.path.commands : [];
  const parts = [];

  for (const command of commands) {
    const args = command.args || [];
    switch (command.command) {
      case "moveTo":
        parts.push(`M ${args[0]} ${-args[1]}`);
        break;
      case "lineTo":
        parts.push(`L ${args[0]} ${-args[1]}`);
        break;
      case "quadraticCurveTo":
        parts.push(`Q ${args[0]} ${-args[1]} ${args[2]} ${-args[3]}`);
        break;
      case "bezierCurveTo":
        parts.push(`C ${args[0]} ${-args[1]} ${args[2]} ${-args[3]} ${args[4]} ${-args[5]}`);
        break;
      case "closePath":
        parts.push("Z");
        break;
      default:
        throw new Error(`Unsupported glyph path command: ${command.command}`);
    }
  }

  return parts.join(" ");
}

function wrapParagraph(fontSet, text, fontSize, maxWidth, emojiRuntime = null) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  const widthOf = (value) => getTextWidth(fontSet, value, fontSize, emojiRuntime);

  const pushCurrent = () => {
    if (current.trim().length) {
      lines.push(current.trim());
    }
    current = "";
  };

  const breakLongWord = (word) => {
    const parts = [];
    let chunk = "";

    for (const char of Array.from(word)) {
      const nextChunk = chunk + char;
      if (widthOf(nextChunk) <= maxWidth) {
        chunk = nextChunk;
        continue;
      }

      if (chunk.length) {
        parts.push(chunk);
      }
      chunk = char;
    }

    if (chunk.length) {
      parts.push(chunk);
    }

    return parts;
  };

  for (const word of words) {
    const parts = widthOf(word) <= maxWidth ? [word] : breakLongWord(word);

    for (const part of parts) {
      const candidate = current ? `${current} ${part}` : part;
      if (widthOf(candidate) <= maxWidth) {
        current = candidate;
      } else {
        pushCurrent();
        current = part;
      }
    }
  }

  pushCurrent();
  return lines.length ? lines : [""];
}

function wrapText(font, text, fontSize, maxWidth, emojiRuntime = null) {
  return String(text)
    .split(/\r?\n/)
    .flatMap((paragraph) => wrapParagraph(font, paragraph, fontSize, maxWidth, emojiRuntime));
}

function getLineMetrics(primaryFont, fontSize) {
  const scale = fontSize / primaryFont.unitsPerEm;
  const descent = primaryFont.descent * scale;
  const textHeight = (primaryFont.ascent - primaryFont.descent) * scale;
  const gap = Math.max(primaryFont.lineGap * scale, fontSize * 0.2);

  return {
    scale,
    descent,
    textHeight,
    lineHeight: textHeight + gap,
  };
}

function calculateBlockHeight(primaryFont, lines, fontSize) {
  if (!lines.length) {
    return 0;
  }
  const metrics = getLineMetrics(primaryFont, fontSize);
  return metrics.textHeight + (lines.length - 1) * metrics.lineHeight;
}

function drawFallbackQuestionGlyph(page, primaryFont, fontSize, xPt, baselineY) {
  const run = primaryFont.layout("?");
  const scale = fontSize / primaryFont.unitsPerEm;
  let penUnits = 0;

  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index];
    const position = run.positions[index];
    if (hasDrawableGlyphOutline(glyph)) {
      page.drawSvgPath(glyphPathToSvg(glyph), {
        x: xPt + (penUnits + position.xOffset) * scale,
        y: baselineY + position.yOffset * scale,
        scale,
        color: rgb(0, 0, 0),
      });
    }
    penUnits += position.xAdvance;
  }
}

async function drawLine({
  page,
  pdfDoc,
  fontSet,
  line,
  fontSize,
  originX,
  baselineY,
  lineMetrics,
  emojiRuntime,
  warnings,
  embeddedEmojiCache,
}) {
  const layout = getLineLayout(fontSet, line, fontSize, emojiRuntime);

  for (const segment of layout.segments) {
    if (segment.kind === "emoji") {
      const bytes = await resolveAppleEmojiPngBuffer(segment.cluster, emojiRuntime, warnings);
      if (!bytes) {
        drawFallbackQuestionGlyph(
          page,
          fontSet.primary,
          fontSize,
          originX + segment.xPt,
          baselineY,
        );
        continue;
      }

      let image = embeddedEmojiCache.get(segment.cluster);
      if (!image) {
        image = await pdfDoc.embedPng(bytes);
        embeddedEmojiCache.set(segment.cluster, image);
      }

      const imageWidthPx = Number(image.width) || 1;
      const imageHeightPx = Number(image.height) || 1;
      const imageAspect = imageWidthPx / imageHeightPx;
      const slotWidthPt = segment.widthPt;
      const slotHeightPt = segment.heightPt;
      let drawWidthPt = slotWidthPt;
      let drawHeightPt = drawWidthPt / imageAspect;

      // Keep emoji inside a square slot and preserve original image proportions.
      if (drawHeightPt > slotHeightPt) {
        drawHeightPt = slotHeightPt;
        drawWidthPt = drawHeightPt * imageAspect;
      }

      const offsetXPt = (slotWidthPt - drawWidthPt) / 2;
      const offsetYPt = (slotHeightPt - drawHeightPt) / 2;

      page.drawImage(image, {
        x: originX + segment.xPt + offsetXPt,
        y: baselineY + lineMetrics.descent + (lineMetrics.textHeight - slotHeightPt) / 2 + offsetYPt,
        width: drawWidthPt,
        height: drawHeightPt,
      });
      continue;
    }

    let penUnits = 0;
    for (let index = 0; index < segment.glyphs.length; index += 1) {
      const glyph = segment.glyphs[index];
      const position = segment.positions[index];
      if (hasDrawableGlyphOutline(glyph)) {
        page.drawSvgPath(glyphPathToSvg(glyph), {
          x: originX + segment.xPt + (penUnits + position.xOffset) * segment.scale,
          y: baselineY + position.yOffset * segment.scale,
          scale: segment.scale,
          color: rgb(0, 0, 0),
        });
      }
      penUnits += position.xAdvance;
    }
  }
}

function fitTextToBox(fontSet, text, widthPt, heightPt, emojiRuntime = null) {
  let fontSize = Math.max(DEFAULT_FONT_SIZE, Math.floor(Math.min(widthPt, heightPt) * 0.65));
  let lines = [];

  while (fontSize >= MIN_FONT_SIZE) {
    lines = wrapText(fontSet, text, fontSize, widthPt, emojiRuntime);

    const blockHeight = calculateBlockHeight(fontSet.primary, lines, fontSize);
    const maxLineWidth = Math.max(
      ...lines.map((line) => getTextWidth(fontSet, line, fontSize, emojiRuntime)),
      0,
    );

    if (maxLineWidth <= widthPt && blockHeight <= heightPt) {
      break;
    }

    fontSize -= 1;
  }

  if (fontSize < MIN_FONT_SIZE) {
    fontSize = MIN_FONT_SIZE;
    lines = wrapText(fontSet, text, fontSize, widthPt, emojiRuntime);
  }

  return {
    fontSize,
    lines,
  };
}

async function drawTextInBox(page, pdfDoc, fontSet, text, box, emojiRuntime, warnings) {
  const fit = fitTextToBox(fontSet, text, box.width, box.height, emojiRuntime);
  const lineMetrics = getLineMetrics(fontSet.primary, fit.fontSize);
  const blockHeight = calculateBlockHeight(fontSet.primary, fit.lines, fit.fontSize);
  const contentBottom = box.y + (box.height - blockHeight) / 2;
  const baselineBottom = contentBottom - lineMetrics.descent;
  const embeddedEmojiCache = new Map();

  for (let index = 0; index < fit.lines.length; index += 1) {
    const line = fit.lines[index];
    const layout = getLineLayout(fontSet, line, fit.fontSize, emojiRuntime);
    const lineWidth = layout.width;
    const x = box.x + (box.width - lineWidth) / 2 - layout.minX;
    const y = baselineBottom + (fit.lines.length - 1 - index) * lineMetrics.lineHeight;
    await drawLine({
      page,
      pdfDoc,
      fontSet,
      line,
      fontSize: fit.fontSize,
      originX: x,
      baselineY: y,
      lineMetrics,
      emojiRuntime,
      warnings,
      embeddedEmojiCache,
    });
  }
}

function getAdaptivePaddingMm(widthMm, heightMm) {
  return Math.min(
    MAX_PADDING_MM,
    Math.max(MIN_PADDING_MM, Math.min(widthMm, heightMm) * 0.08),
  );
}

function resolveEngravingZone(format) {
  const normalizedFormat = String(format || "").toUpperCase();
  if (normalizedFormat === "A4") {
    return ENGRAVING_ZONE_BY_FORMAT.A4;
  }
  return ENGRAVING_ZONE_BY_FORMAT.A5;
}

async function createEngravingPdf({ text, format, outPath, fontSet, emojiRuntime, warnings }) {
  const zone = resolveEngravingZone(format);
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([mmToPt(A3_WIDTH_MM), mmToPt(A3_HEIGHT_MM)]);
  const pageWidthPt = page.getWidth();
  const zoneWidthPt = mmToPt(zone.widthMm);
  const paddingMm = getAdaptivePaddingMm(zone.widthMm, zone.heightMm);
  const paddingPt = mmToPt(paddingMm);
  const zoneOriginXPt = pageWidthPt - zoneWidthPt;

  await drawTextInBox(page, pdfDoc, fontSet, text || "", {
    x: zoneOriginXPt + paddingPt,
    y: paddingPt,
    width: zoneWidthPt - paddingPt * 2,
    height: mmToPt(zone.heightMm) - paddingPt * 2,
  }, emojiRuntime, warnings);

  const pdfBytes = await pdfDoc.save();
  await fsp.writeFile(outPath, pdfBytes);

  return {
    zone_width_mm: zone.widthMm,
    zone_height_mm: zone.heightMm,
    page: "A3",
    corner: "bottom-right",
  };
}

async function createStickerPdf({ text, outPath, fontSet, stickerSizeMm, emojiRuntime, warnings }) {
  const sizeMm = Number.isFinite(Number(stickerSizeMm))
    ? Number(stickerSizeMm)
    : DEFAULT_STICKER_SIZE_MM;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([mmToPt(sizeMm), mmToPt(sizeMm)]);
  const paddingMm = Math.max(4, Math.min(8, sizeMm * 0.08));
  const paddingPt = mmToPt(paddingMm);

  await drawTextInBox(page, pdfDoc, fontSet, text || "", {
    x: paddingPt,
    y: paddingPt,
    width: mmToPt(sizeMm) - paddingPt * 2,
    height: mmToPt(sizeMm) - paddingPt * 2,
  }, emojiRuntime, warnings);

  const pdfBytes = await pdfDoc.save();
  await fsp.writeFile(outPath, pdfBytes);

  return {
    size_mm: sizeMm,
  };
}

function resolveQrPlacement(format, qrPlacementByFormat) {
  const normalizedFormat = String(format ?? "").toUpperCase();
  const placement = qrPlacementByFormat?.[normalizedFormat] ?? null;
  if (!placement) {
    return null;
  }

  const sizeMm = Number(placement.sizeMm);
  const hasAbsoluteCoords = placement.xMm !== null && placement.xMm !== undefined &&
    placement.yMm !== null && placement.yMm !== undefined;
  const hasRightBottomOffsets = placement.rightMm !== null && placement.rightMm !== undefined &&
    placement.bottomMm !== null && placement.bottomMm !== undefined;

  const xMm = hasAbsoluteCoords ? Number(placement.xMm) : Number.NaN;
  const yMm = hasAbsoluteCoords ? Number(placement.yMm) : Number.NaN;
  const rightMm = hasRightBottomOffsets ? Number(placement.rightMm) : Number.NaN;
  const bottomMm = hasRightBottomOffsets ? Number(placement.bottomMm) : Number.NaN;

  if (!Number.isFinite(sizeMm) || sizeMm <= 0) {
    return null;
  }

  if (Number.isFinite(xMm) && Number.isFinite(yMm)) {
    return {
      anchor: "left-bottom",
      xMm,
      yMm,
      sizeMm,
    };
  }

  if (Number.isFinite(rightMm) && Number.isFinite(bottomMm)) {
    return {
      anchor: "right-bottom",
      rightMm,
      bottomMm,
      sizeMm,
    };
  }

  return null;
}

function toPdfRgbFromHex(colorHex) {
  const parsed = parseHexColor(colorHex);
  return rgb(parsed.r / 255, parsed.g / 255, parsed.b / 255);
}

async function embedQrIntoPosterPdf({ posterPath, qrUrl, placement, qrHex = "FFFEFA" }) {
  const pdfBytes = await fsp.readFile(posterPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPage(0);
  const sizePt = mmToPt(placement.sizeMm);
  const pageWidthPt = page.getWidth();
  const pageHeightPt = page.getHeight();
  const xPt =
    placement.anchor === "right-bottom"
      ? pageWidthPt - mmToPt(placement.rightMm) - sizePt
      : mmToPt(placement.xMm);
  const yPt =
    placement.anchor === "right-bottom" ? mmToPt(placement.bottomMm) : mmToPt(placement.yMm);

  if (
    !Number.isFinite(xPt) ||
    !Number.isFinite(yPt) ||
    xPt < 0 ||
    yPt < 0 ||
    xPt + sizePt > pageWidthPt ||
    yPt + sizePt > pageHeightPt
  ) {
    throw new Error("Computed QR placement is out of page bounds.");
  }

  const qrModel = QRCode.create(String(qrUrl), {
    errorCorrectionLevel: "M",
  });
  const moduleCount = qrModel?.modules?.size;
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) {
    throw new Error("Failed to build QR matrix.");
  }

  // Keep a transparent quiet zone around QR (no background fill).
  const quietZoneModules = 1;
  const moduleSizePt = sizePt / (moduleCount + quietZoneModules * 2);
  const modulesOriginX = xPt + quietZoneModules * moduleSizePt;
  const modulesOriginY = yPt + quietZoneModules * moduleSizePt;
  const qrColor = toPdfRgbFromHex(qrHex);
  // Prevent thin stitching gaps between adjacent module rectangles in some PDF viewers/RIPs.
  const moduleOverlapPt = Math.min(0.2, moduleSizePt * 0.08);

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (!qrModel.modules.get(col, row)) {
        continue;
      }

      page.drawRectangle({
        x: modulesOriginX + col * moduleSizePt - moduleOverlapPt / 2,
        y: modulesOriginY + (moduleCount - 1 - row) * moduleSizePt - moduleOverlapPt / 2,
        width: moduleSizePt + moduleOverlapPt,
        height: moduleSizePt + moduleOverlapPt,
        color: qrColor,
      });
    }
  }

  const outBytes = await pdfDoc.save();
  await fsp.writeFile(posterPath, outBytes);

  return {
    embedded: true,
    url: qrUrl,
    color_hex: parseHexColor(qrHex).hex,
    placement_mm: placement,
  };
}

async function downloadFile({ url, outPath, sourceRequestOptions = {} }) {
  if (!url) {
    throw new Error("Poster source URL is missing.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }

  const requestOptions = normalizeSourceRequestOptions(sourceRequestOptions);
  const maxAttempts = requestOptions.retries + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          redirect: "follow",
        },
        requestOptions.timeoutMs,
      );

      if (!response.ok) {
        const retryable = isRetryableStatusCode(response.status);
        if (retryable && attempt < maxAttempts) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const delayMs =
            retryAfterMs ?? computeBackoffDelayMs(attempt, requestOptions.retryBaseMs);
          await sleep(delayMs);
          continue;
        }

        throw new Error(`Failed to download poster PDF (${response.status}).`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsp.writeFile(outPath, buffer);

      return {
        bytes: buffer.length,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableFetchError(error)) {
        const delayMs = computeBackoffDelayMs(attempt, requestOptions.retryBaseMs);
        await sleep(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error("Failed to download poster PDF.");
}

async function loadFont(fontPath) {
  if (!fs.existsSync(fontPath)) {
    throw new Error(`Font file not found: ${fontPath}`);
  }
  const fontBytes = await fsp.readFile(fontPath);
  return fontkit.create(fontBytes);
}

async function loadOptionalFont(fontPath) {
  const normalizedPath = String(fontPath ?? "").trim();
  if (!normalizedPath) {
    return null;
  }

  if (!fs.existsSync(normalizedPath)) {
    return null;
  }

  const fontBytes = await fsp.readFile(normalizedPath);
  return fontkit.create(fontBytes);
}

function containsEmoji(text) {
  return /\p{Extended_Pictographic}/u.test(String(text ?? ""));
}

async function generateMaterialFiles({
  layoutPlan,
  outputRoot,
  orderId,
  fontPath,
  emojiFontPath = "",
  emojiRenderMode = "font",
  appleEmojiBaseUrl = "https://em-content.zobj.net/source/apple/391",
  appleEmojiAssetsDir = "",
  stickerSizeMm = DEFAULT_STICKER_SIZE_MM,
  colorSpace = "RGB",
  qrPlacementByFormat = {},
  sourceRequestOptions = {},
  replaceWhiteWithOffWhite = true,
  offWhiteHex = "FFFEFA",
  whiteThreshold = 245,
  whiteMaxSaturation = 0.12,
  rasterizeDpi = 300,
  whiteReplaceMode = "photoshop_like",
  whiteLabDeltaEMax = 20,
  whiteLabSoftness = 8,
  whiteMinLightness = 87,
  whiteFeatherPx = 0.8,
  whiteMinAlpha = 0,
  whiteCleanupPasses = 1,
  whiteCleanupMinChannel = 248,
  whiteCleanupMaxSaturation = 0.35,
  whiteHardCleanupPasses = 2,
  whiteHardCleanupMinChannel = 246,
  whiteHardCleanupMinLightness = 98.5,
  whiteHardCleanupDeltaEMax = 14,
  whiteHardCleanupMaxSaturation = 0.6,
  whiteSanitizeTransparentRgb = true,
  whiteAllowSoftMaskFallback = false,
  whiteReplaceIterations = 2,
  whiteFinalEnforce = true,
  whiteFinalIterations = 2,
  whiteFinalThreshold = 254,
  whiteFinalMaxSaturation = 0.25,
  whiteFinalDpi = 300,
}) {
  const resolvedOutputRoot = path.resolve(outputRoot);
  const orderOutputDir = path.join(resolvedOutputRoot, String(orderId));
  await fsp.mkdir(orderOutputDir, { recursive: true });
  const normalizedColorSpace = normalizeColorSpace(colorSpace);
  const warnings = [];
  const safeSourceRequestOptions = normalizeSourceRequestOptions(sourceRequestOptions);
  const safeWhiteReplaceIterations = Number.isFinite(Number(whiteReplaceIterations))
    ? Math.max(1, Math.min(3, Math.floor(Number(whiteReplaceIterations))))
    : 2;
  const safeWhiteFinalIterations = Number.isFinite(Number(whiteFinalIterations))
    ? Math.max(1, Math.min(3, Math.floor(Number(whiteFinalIterations))))
    : 2;
  const safeWhiteFinalThreshold = Number.isFinite(Number(whiteFinalThreshold))
    ? Math.max(0, Math.min(255, Math.round(Number(whiteFinalThreshold))))
    : 254;
  const safeWhiteFinalMaxSaturation = Number.isFinite(Number(whiteFinalMaxSaturation))
    ? Math.max(0, Math.min(1, Number(whiteFinalMaxSaturation)))
    : 0.25;
  const safeWhiteFinalDpi = Number.isFinite(Number(whiteFinalDpi))
    ? Math.max(72, Number(whiteFinalDpi))
    : 300;
  const safeWhiteHardCleanupPasses = Number.isFinite(Number(whiteHardCleanupPasses))
    ? Math.max(0, Math.min(5, Math.floor(Number(whiteHardCleanupPasses))))
    : 2;
  const safeWhiteHardCleanupMinChannel = Number.isFinite(Number(whiteHardCleanupMinChannel))
    ? Math.max(0, Math.min(255, Math.round(Number(whiteHardCleanupMinChannel))))
    : 246;
  const safeWhiteHardCleanupMinLightness = Number.isFinite(Number(whiteHardCleanupMinLightness))
    ? Math.max(0, Math.min(100, Number(whiteHardCleanupMinLightness)))
    : 98.5;
  const safeWhiteHardCleanupDeltaEMax = Number.isFinite(Number(whiteHardCleanupDeltaEMax))
    ? Math.max(0.1, Number(whiteHardCleanupDeltaEMax))
    : 14;
  const safeWhiteHardCleanupMaxSaturation = Number.isFinite(Number(whiteHardCleanupMaxSaturation))
    ? Math.max(0, Math.min(1, Number(whiteHardCleanupMaxSaturation)))
    : 0.6;
  const safeWhiteSanitizeTransparentRgb = Boolean(whiteSanitizeTransparentRgb);
  const safeEmojiRenderMode =
    String(emojiRenderMode ?? "font").trim().toLowerCase() === "apple_image"
      ? "apple_image"
      : "font";
  const safeAppleEmojiBaseUrl = String(appleEmojiBaseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const safeAppleEmojiAssetsDir = String(appleEmojiAssetsDir ?? "").trim();
  const resolvedAppleEmojiAssetsDir = safeAppleEmojiAssetsDir
    ? path.resolve(safeAppleEmojiAssetsDir)
    : "";
  const emojiRuntime = {
    mode: safeEmojiRenderMode,
    baseUrl: safeAppleEmojiBaseUrl,
    assetsDir: resolvedAppleEmojiAssetsDir,
    bytesCache: new Map(),
    missingWarned: new Set(),
  };

  if (emojiRuntime.mode === "apple_image") {
    if (emojiRuntime.assetsDir && !fs.existsSync(emojiRuntime.assetsDir)) {
      warnings.push(`Директорія Apple emoji не знайдена: ${emojiRuntime.assetsDir}`);
    }
    if (!emojiRuntime.assetsDir && !emojiRuntime.baseUrl) {
      warnings.push(
        "Apple emoji mode увімкнено, але не задано APPLE_EMOJI_BASE_URL або APPLE_EMOJI_ASSETS_DIR.",
      );
    }
  }

  // Cleanup old standalone QR artifact from previous logic versions.
  try {
    await fsp.unlink(path.join(orderOutputDir, "QR.pdf"));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      warnings.push(`Не вдалося видалити застарілий QR.pdf: ${error.message}`);
    }
  }

  const textBasedMaterials = (layoutPlan?.materials ?? []).filter(
    (material) => material.type === "engraving" || material.type === "sticker",
  );
  let fontSet = null;
  if (textBasedMaterials.length) {
    const primaryFont = await loadFont(path.resolve(fontPath));
    const resolvedEmojiFontPath = String(emojiFontPath ?? "").trim();
    let emojiFont = null;

    if (resolvedEmojiFontPath) {
      emojiFont = await loadOptionalFont(path.resolve(resolvedEmojiFontPath));
      if (!emojiFont) {
        warnings.push(
          `Emoji font не знайдено: ${resolvedEmojiFontPath}. Смайлики можуть не відображатися.`,
        );
      }
    }

    fontSet = createFontSet(primaryFont, emojiFont ? [emojiFont] : []);

    const hasEmojiInText = textBasedMaterials.some((material) => containsEmoji(material.text));
    if (hasEmojiInText) {
      if (emojiRuntime.mode === "apple_image") {
        if (!emojiRuntime.assetsDir && !emojiRuntime.baseUrl) {
          warnings.push(
            "У тексті є emoji, але для apple_image mode не задано джерело emoji PNG.",
          );
        }
      } else if (fontSet.fallbacks.length === 0) {
        warnings.push(
          "У тексті є emoji, але emoji fallback font не заданий. Додайте EMOJI_FONT_PATH.",
        );
      }
    }
  }

  if (normalizedColorSpace === "CMYK") {
    await ensureGhostscriptAvailable();
  }

  const generated = [];
  const failed = [];

  const applyWhiteRecolorWithIterations = async ({ filePath, stripSoftMask }) => {
    let lastStats = null;
    let iterationsUsed = 0;

    for (let pass = 0; pass < safeWhiteReplaceIterations; pass += 1) {
      const passStats = await replaceWhiteInPdfWithOffWhiteInPlace({
        filePath,
        offWhiteHex,
        threshold: whiteThreshold,
        maxSaturation: whiteMaxSaturation,
        dpi: rasterizeDpi,
        stripSoftMask,
        mode: whiteReplaceMode,
        labDeltaEMax: whiteLabDeltaEMax,
        labSoftness: whiteLabSoftness,
        minLightness: whiteMinLightness,
        featherPx: whiteFeatherPx,
        minAlpha: whiteMinAlpha,
        cleanupPasses: whiteCleanupPasses,
        cleanupMinChannel: whiteCleanupMinChannel,
        cleanupMaxSaturation: whiteCleanupMaxSaturation,
        hardCleanupPasses: safeWhiteHardCleanupPasses,
        hardCleanupMinChannel: safeWhiteHardCleanupMinChannel,
        hardCleanupMinLightness: safeWhiteHardCleanupMinLightness,
        hardCleanupDeltaEMax: safeWhiteHardCleanupDeltaEMax,
        hardCleanupMaxSaturation: safeWhiteHardCleanupMaxSaturation,
        sanitizeTransparentRgb: safeWhiteSanitizeTransparentRgb,
        allowSoftMaskFallback: whiteAllowSoftMaskFallback,
      });
      lastStats = passStats;
      iterationsUsed += 1;

      const changedPixels =
        (passStats?.replaced_pixels ?? 0) +
        (passStats?.cleanup_replaced_pixels ?? 0) +
        (passStats?.forced_opaque_pixels ?? 0);
      if (changedPixels <= 0) {
        break;
      }
    }

    return {
      ...(lastStats ?? {}),
      iterations_requested: safeWhiteReplaceIterations,
      iterations_used: iterationsUsed,
    };
  };

  const applyStrictFinalWhiteCleanup = async ({ filePath, stripSoftMask }) => {
    if (!whiteFinalEnforce) {
      return {
        applied: false,
        reason: "disabled",
      };
    }

    let lastStats = null;
    let iterationsUsed = 0;

    for (let pass = 0; pass < safeWhiteFinalIterations; pass += 1) {
      const passStats = await replaceWhiteInPdfWithOffWhiteInPlace({
        filePath,
        offWhiteHex,
        threshold: safeWhiteFinalThreshold,
        maxSaturation: safeWhiteFinalMaxSaturation,
        dpi: safeWhiteFinalDpi,
        stripSoftMask,
        mode: "threshold",
        minAlpha: 0,
        cleanupPasses: 0,
        cleanupMinChannel: safeWhiteFinalThreshold,
        cleanupMaxSaturation: safeWhiteFinalMaxSaturation,
        hardCleanupPasses: safeWhiteHardCleanupPasses,
        hardCleanupMinChannel: safeWhiteHardCleanupMinChannel,
        hardCleanupMinLightness: safeWhiteHardCleanupMinLightness,
        hardCleanupDeltaEMax: safeWhiteHardCleanupDeltaEMax,
        hardCleanupMaxSaturation: safeWhiteHardCleanupMaxSaturation,
        sanitizeTransparentRgb: safeWhiteSanitizeTransparentRgb,
        // Keep transparent shapes intact to avoid black background artifacts.
        allowSoftMaskFallback: true,
      });
      lastStats = passStats;
      iterationsUsed += 1;

      const changedPixels =
        (passStats?.replaced_pixels ?? 0) +
        (passStats?.cleanup_replaced_pixels ?? 0) +
        (passStats?.forced_opaque_pixels ?? 0);
      if (changedPixels <= 0) {
        break;
      }
    }

    return {
      ...(lastStats ?? {}),
      mode: "strict_final_near_white",
      iterations_requested: safeWhiteFinalIterations,
      iterations_used: iterationsUsed,
    };
  };

  for (const material of layoutPlan?.materials ?? []) {
    const fileName = `${material.filename}.pdf`;
    const filePath = path.join(orderOutputDir, fileName);

    try {
      let details = {};

      let whiteRecolorAppliedEarly = false;

      if (material.type === "poster") {
        details = await downloadFile({
          url: material.source_url,
          outPath: filePath,
          sourceRequestOptions: safeSourceRequestOptions,
        });

        // Recolor poster before QR embedding so QR stays crisp and fully filled.
        if (replaceWhiteWithOffWhite) {
          details.white_recolor = await applyWhiteRecolorWithIterations({
            filePath,
            stripSoftMask: true,
          });
          whiteRecolorAppliedEarly = true;
        }

        if (layoutPlan?.qr?.should_generate && layoutPlan?.qr?.url) {
          const qrPlacement = resolveQrPlacement(material.format, qrPlacementByFormat);
          if (!qrPlacement) {
            warnings.push(`QR для формату ${material.format || "N/A"} не вбудовано: не задані параметри розміщення.`);
            details.qr = {
              embedded: false,
              reason: "placement_not_configured",
            };
          } else {
            details.qr = await embedQrIntoPosterPdf({
              posterPath: filePath,
              qrUrl: layoutPlan.qr.url,
              placement: qrPlacement,
              qrHex: offWhiteHex,
            });
          }
        }
      } else if (material.type === "engraving") {
        details = await createEngravingPdf({
          text: material.text || "",
          format: material.format,
          outPath: filePath,
          fontSet,
          emojiRuntime,
          warnings,
        });
      } else if (material.type === "sticker") {
        details = await createStickerPdf({
          text: material.text || "",
          outPath: filePath,
          fontSet,
          stickerSizeMm,
          emojiRuntime,
          warnings,
        });
      } else {
        throw new Error(`Unsupported material type: ${material.type}`);
      }

      if (replaceWhiteWithOffWhite && !whiteRecolorAppliedEarly) {
        details.white_recolor = await applyWhiteRecolorWithIterations({
          filePath,
          stripSoftMask: false,
        });
      }

      if (normalizedColorSpace === "CMYK") {
        await convertPdfToCmykInPlace(filePath);
      }

      if (replaceWhiteWithOffWhite) {
        details.white_recolor_final = await applyStrictFinalWhiteCleanup({
          filePath,
          stripSoftMask: material.type === "poster",
        });
      }

      details.color_space = normalizedColorSpace;

      generated.push({
        type: material.type,
        filename: fileName,
        path: filePath,
        details,
      });
    } catch (error) {
      failed.push({
        type: material.type,
        filename: fileName,
        path: filePath,
        message: error.message,
      });
    }
  }

  return {
    output_dir: orderOutputDir,
    color_space: normalizedColorSpace,
    warnings,
    generated,
    failed,
  };
}

async function enforceOffWhiteInPdf({
  filePath,
  offWhiteHex = "FFFEFA",
  rasterizeDpi = 300,
}) {
  return replaceWhiteInPdfWithOffWhiteInPlace({
    filePath,
    offWhiteHex,
    threshold: 254,
    maxSaturation: 0.25,
    dpi: rasterizeDpi,
    stripSoftMask: true,
    mode: "threshold",
    minAlpha: 0,
    cleanupPasses: 0,
    cleanupMinChannel: 254,
    cleanupMaxSaturation: 0.25,
    hardCleanupPasses: 2,
    hardCleanupMinChannel: 246,
    hardCleanupMinLightness: 98.5,
    hardCleanupDeltaEMax: 14,
    hardCleanupMaxSaturation: 0.6,
    sanitizeTransparentRgb: true,
    allowSoftMaskFallback: true,
  });
}

module.exports = {
  generateMaterialFiles,
  enforceOffWhiteInPdf,
};
