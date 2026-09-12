// Talks to the Spotify Web API using a token minted by our own backend.
// The client secret must never ship inside the app bundle, so the
// client-credentials exchange stays on the Netlify function.

const TOKEN_ENDPOINT = process.env.EXPO_PUBLIC_SPOTIFY_TOKEN_ENDPOINT;
const API = 'https://api.spotify.com/v1';

// Refresh a little before the real expiry so an in-flight request can't
// land on a token that died in transit.
const EXPIRY_MARGIN_MS = 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;
let inFlight = null;

export class SpotifyError extends Error {}

async function requestToken() {
  if (!TOKEN_ENDPOINT) {
    throw new SpotifyError(
      'No token endpoint configured. Set EXPO_PUBLIC_SPOTIFY_TOKEN_ENDPOINT in .env'
    );
  }

  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, { method: 'POST' });
  } catch {
    throw new SpotifyError('Could not reach the server. Check your connection.');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new SpotifyError(
      data.error_description || data.error || 'Spotify authentication failed.'
    );
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
  return cachedToken;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  // Collapse concurrent callers onto a single token request.
  inFlight = inFlight ?? requestToken().finally(() => { inFlight = null; });
  return inFlight;
}

async function authorizedGet(path, { retryOnExpiry = true } = {}) {
  const token = await getToken();

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SpotifyError('Could not reach Spotify. Check your connection.');
  }

  // A token can be revoked server-side before its stated expiry.
  if (response.status === 401 && retryOnExpiry) {
    cachedToken = null;
    tokenExpiresAt = 0;
    return authorizedGet(path, { retryOnExpiry: false });
  }

  if (response.status === 429) {
    throw new SpotifyError('Too many searches at once. Wait a moment and try again.');
  }

  if (!response.ok) {
    throw new SpotifyError('Spotify returned an error. Try again.');
  }

  return response.json();
}

export async function searchArtists(query, limit = 5) {
  const data = await authorizedGet(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}`
  );
  return data.artists?.items ?? [];
}

export async function getArtistAlbums(artistId) {
  const data = await authorizedGet(`/artists/${artistId}/albums?limit=50`);
  return data.items ?? [];
}

// Mirrors the web app's behaviour of jumping straight to the top artist match.
export async function searchTopArtistAlbums(query) {
  const [artist] = await searchArtists(query, 1);
  if (!artist) throw new SpotifyError(`No artist found for "${query}".`);
  return { artist, albums: await getArtistAlbums(artist.id) };
}

// Spotify returns cover art largest-first.
export function largestImage(album) {
  return album.images?.[0]?.url ?? null;
}
