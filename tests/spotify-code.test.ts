import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpotifyUri } from "../src/modules/qr/spotify-code";

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
