import fs from "node:fs/promises";

export type QrPlacement = {
  mode: "right_bottom" | "bottom_center";
  widthMm: number;
  heightMm: number;
  rightMm?: number;
  bottomMm: number;
};

export type QrProfile = {
  id: string;
  skus: string[];
  qrPlacementByFormat: {
    A5: QrPlacement;
    A4: QrPlacement;
  };
  spotifyPlacementByFormat?: {
    A5: QrPlacement;
    A4: QrPlacement;
  };
};

export type QrRules = {
  profiles: QrProfile[];
};

export type QrCodeStrategy = "none" | "qr" | "spotify_code";

export type QrCodeDecision = {
  strategy: QrCodeStrategy;
  profileId: string | null;
  qrPlacementByFormat: QrProfile["qrPlacementByFormat"] | null;
  spotifyPlacement: QrPlacement | null;
  reason: string;
};

function normalizeSkuKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizePlacement(raw: unknown): QrPlacement | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const mode = source.mode === "bottom_center" ? "bottom_center" : "right_bottom";
  const widthMm = Number(source.widthMm);
  const heightMm = Number(source.heightMm);
  const rightMm = source.rightMm !== undefined ? Number(source.rightMm) : undefined;
  const bottomMm = Number(source.bottomMm);

  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    return null;
  }

  if (!Number.isFinite(heightMm) || heightMm <= 0) {
    return null;
  }

  if (!Number.isFinite(bottomMm) || bottomMm < 0) {
    return null;
  }

  if (mode === "right_bottom" && (!Number.isFinite(rightMm) || Number(rightMm) < 0)) {
    return null;
  }

  return {
    mode,
    widthMm,
    heightMm,
    rightMm: mode === "right_bottom" ? Number(rightMm) : undefined,
    bottomMm,
  };
}

function normalizeProfile(raw: unknown): QrProfile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const id = String(source.id ?? "").trim();
  if (!id) {
    return null;
  }

  const skusRaw = Array.isArray(source.skus) ? source.skus : [];
  const skus = skusRaw.map((item) => normalizeSkuKey(String(item))).filter(Boolean);
  if (skus.length === 0) {
    return null;
  }

  const qrPlacementSource =
    source.qrPlacementByFormat && typeof source.qrPlacementByFormat === "object"
      ? (source.qrPlacementByFormat as Record<string, unknown>)
      : {};

  const qrA5 = normalizePlacement(qrPlacementSource.A5);
  const qrA4 = normalizePlacement(qrPlacementSource.A4);
  if (!qrA5 || !qrA4) {
    return null;
  }

  const spotifyPlacementSource =
    source.spotifyPlacementByFormat && typeof source.spotifyPlacementByFormat === "object"
      ? (source.spotifyPlacementByFormat as Record<string, unknown>)
      : null;

  let spotifyPlacementByFormat: QrProfile["spotifyPlacementByFormat"] | undefined = undefined;
  if (spotifyPlacementSource) {
    const spotifyA5 = normalizePlacement(spotifyPlacementSource.A5);
    const spotifyA4 = normalizePlacement(spotifyPlacementSource.A4);
    if (spotifyA5 && spotifyA4) {
      spotifyPlacementByFormat = {
        A5: spotifyA5,
        A4: spotifyA4,
      };
    }
  }

  return {
    id,
    skus,
    qrPlacementByFormat: {
      A5: qrA5,
      A4: qrA4,
    },
    spotifyPlacementByFormat,
  };
}

export async function loadQrRules(filePath: string): Promise<QrRules> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  const source = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const profilesRaw = Array.isArray(source.profiles) ? source.profiles : [];
  const profiles = profilesRaw
    .map((item) => normalizeProfile(item))
    .filter((item): item is QrProfile => Boolean(item));

  if (profiles.length === 0) {
    throw new Error("qr-rules: at least one valid profile is required.");
  }

  const ids = new Set<string>();
  const skuOwners = new Map<string, string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`qr-rules: duplicate profile id "${profile.id}".`);
    }
    ids.add(profile.id);

    for (const sku of profile.skus) {
      const existing = skuOwners.get(sku);
      if (existing) {
        throw new Error(
          `qr-rules: SKU "${sku}" is assigned to multiple profiles ("${existing}" and "${profile.id}").`,
        );
      }
      skuOwners.set(sku, profile.id);
    }
  }

  return {
    profiles,
  };
}

export function isSpotifyLink(value: string): boolean {
  const urlText = String(value ?? "").trim();
  if (!urlText) {
    return false;
  }

  if (urlText.toLowerCase().startsWith("spotify:")) {
    return true;
  }

  try {
    const parsed = new URL(urlText);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "open.spotify.com" ||
      hostname === "spotify.link" ||
      hostname === "spoti.fi"
    );
  } catch (_error) {
    return false;
  }
}

export function findQrProfileBySku(rules: QrRules, sku: string): QrProfile | null {
  const normalizedSku = normalizeSkuKey(sku);
  if (!normalizedSku) {
    return null;
  }

  for (const profile of rules.profiles) {
    if (profile.skus.includes(normalizedSku)) {
      return profile;
    }
  }

  return null;
}

export function resolveQrCodeDecision(params: {
  rules: QrRules;
  sku: string;
  format: "A5" | "A4";
  qrRequested: boolean;
  qrValid: boolean;
  qrUrl: string | null;
}): QrCodeDecision {
  if (!params.qrRequested) {
    return {
      strategy: "none",
      profileId: null,
      qrPlacementByFormat: null,
      spotifyPlacement: null,
      reason: "qr_not_requested",
    };
  }

  if (!params.qrValid || !params.qrUrl) {
    return {
      strategy: "none",
      profileId: null,
      qrPlacementByFormat: null,
      spotifyPlacement: null,
      reason: "qr_url_invalid",
    };
  }

  const profile = findQrProfileBySku(params.rules, params.sku);
  if (!profile) {
    return {
      strategy: "none",
      profileId: null,
      qrPlacementByFormat: null,
      spotifyPlacement: null,
      reason: "sku_not_whitelisted",
    };
  }

  if (isSpotifyLink(params.qrUrl) && profile.spotifyPlacementByFormat) {
    return {
      strategy: "spotify_code",
      profileId: profile.id,
      qrPlacementByFormat: profile.qrPlacementByFormat,
      spotifyPlacement: profile.spotifyPlacementByFormat[params.format],
      reason: "spotify_link",
    };
  }

  return {
    strategy: "qr",
    profileId: profile.id,
    qrPlacementByFormat: profile.qrPlacementByFormat,
    spotifyPlacement: null,
    reason: "regular_qr",
  };
}
