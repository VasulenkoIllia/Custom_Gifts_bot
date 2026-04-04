import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpotifyUri, sanitizeSpotifyScannableSvg } from "../src/modules/qr/spotify-code";

test("resolveSpotifyUri accepts spotify uri as-is", async () => {
  const value = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
  const resolved = await resolveSpotifyUri(value);
  assert.equal(resolved, value);
});

test("resolveSpotifyUri converts open.spotify.com url to spotify uri", async () => {
  const resolved = await resolveSpotifyUri(
    "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=123",
  );

  assert.equal(resolved, "spotify:track:4uLU6hMCjMI75M1A2tKUQC");
});

test("resolveSpotifyUri supports intl spotify url", async () => {
  const resolved = await resolveSpotifyUri(
    "https://open.spotify.com/intl-uk/album/2noRn2Aes5aoNVsU6iWThc",
  );

  assert.equal(resolved, "spotify:album:2noRn2Aes5aoNVsU6iWThc");
});

test("resolveSpotifyUri fails on unsupported url", async () => {
  await assert.rejects(
    async () => resolveSpotifyUri("https://example.com/not-spotify"),
    /supported Spotify link/i,
  );
});

test("sanitizeSpotifyScannableSvg removes background rect and recolors code", () => {
  const input = `<svg width="640" height="160" viewBox="0 0 400 100" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="400" height="100" fill="#000000"/>
<rect x="100" y="20" width="10" height="60" fill="#ffffff"/>
<g><path fill="white" d="M1 1h1v1H1z"/></g>
</svg>`;

  const output = sanitizeSpotifyScannableSvg(input, "FFFEFA");

  assert.ok(!output.includes('width="400" height="100" fill="#000000"'));
  assert.ok(output.includes('fill="#FFFEFA"'));
  assert.ok(!output.includes('fill="#ffffff"'));
  assert.ok(!output.includes('fill="white"'));
});
