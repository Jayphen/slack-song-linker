/**
 * Create a YouTube playlist from songs shared in the past 7 days.
 *
 * Setup:
 *   1. Create OAuth credentials at https://console.cloud.google.com/apis/credentials
 *   2. Download the JSON file and save as scripts/oauth-credentials.json
 *
 * Usage:
 *   1. First export songs from D1:
 *      wrangler d1 execute songlink-shares --remote --json \
 *        --command="SELECT youtube_url, title FROM shared_songs WHERE shared_at > datetime('now', '-7 days') AND youtube_url IS NOT NULL" \
 *        > scripts/songs.json
 *
 *   2. Run this script:
 *      npx tsx scripts/create-playlist.ts
 */

import { google } from "googleapis";
import * as fs from "fs/promises";
import * as http from "http";
import * as url from "url";

const OAUTH_CREDENTIALS_PATH = "scripts/oauth-credentials.json";
const TOKEN_PATH = "scripts/youtube-token.json";
const SONGS_PATH = "scripts/songs.json";
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

interface OAuthCredentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

interface D1Result {
  results: Array<{
    youtube_url: string;
    title?: string;
  }>;
}

async function loadCredentials(): Promise<OAuthCredentials> {
  try {
    const content = await fs.readFile(OAUTH_CREDENTIALS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    console.error(`Error: Could not find ${OAUTH_CREDENTIALS_PATH}`);
    console.error(
      "Download OAuth credentials from Google Cloud Console and save them there.",
    );
    process.exit(1);
  }
}

async function loadSavedToken(): Promise<any | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveToken(token: any): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log(`Token saved to ${TOKEN_PATH}`);
}

async function getAuthenticatedClient() {
  const credentials = await loadCredentials();
  const { client_id, client_secret } =
    credentials.installed || credentials.web || {};

  if (!client_id || !client_secret) {
    console.error("Invalid OAuth credentials file");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3333/oauth2callback",
  );

  // Check for saved token
  const savedToken = await loadSavedToken();
  if (savedToken) {
    console.log("Using saved OAuth token...");
    oauth2Client.setCredentials(savedToken);

    // Refresh if expired
    if (savedToken.expiry_date && savedToken.expiry_date < Date.now()) {
      console.log("Token expired, refreshing...");
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await saveToken(credentials);
    }

    return oauth2Client;
  }

  // Need to get new token via browser
  console.log("\nOpening browser for YouTube authorization...\n");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  // Start local server to receive callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url || "", true);
        if (parsedUrl.pathname === "/oauth2callback") {
          const code = parsedUrl.query.code as string;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authorization successful!</h1><p>You can close this window.</p>",
          );
          server.close();
          resolve(code);
        }
      } catch (e) {
        reject(e);
      }
    });

    server.listen(3333, () => {
      console.log("Waiting for authorization...");
      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Try to open browser
      import("child_process").then(({ exec }) => {
        const command =
          process.platform === "darwin"
            ? `open "${authUrl}"`
            : process.platform === "win32"
              ? `start "${authUrl}"`
              : `xdg-open "${authUrl}"`;
        exec(command);
      });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timeout"));
    }, 120000);
  });

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  await saveToken(tokens);

  return oauth2Client;
}

function extractVideoId(youtubeUrl: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = youtubeUrl.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function loadSongs(): Promise<Array<{ videoId: string; title?: string }>> {
  try {
    const content = await fs.readFile(SONGS_PATH, "utf-8");
    const data: D1Result[] = JSON.parse(content);

    // D1 JSON output is an array with one result object
    const results = data[0]?.results || [];

    const songs: Array<{ videoId: string; title?: string }> = [];
    const seenIds = new Set<string>();

    for (const row of results) {
      if (!row.youtube_url) continue;
      const videoId = extractVideoId(row.youtube_url);
      if (videoId && !seenIds.has(videoId)) {
        seenIds.add(videoId);
        songs.push({ videoId, title: row.title });
      }
    }

    return songs;
  } catch (error) {
    console.error(`Error: Could not load ${SONGS_PATH}`);
    console.error("\nFirst export songs from D1:");
    console.error(
      '  wrangler d1 execute songlink-shares --remote --json --command="SELECT youtube_url, title FROM shared_songs WHERE shared_at > datetime(\'now\', \'-7 days\') AND youtube_url IS NOT NULL" > scripts/songs.json',
    );
    process.exit(1);
  }
}

async function main() {
  console.log("YouTube Playlist Creator\n");

  // Load songs first
  const songs = await loadSongs();
  if (songs.length === 0) {
    console.log("No songs found to add to playlist.");
    return;
  }
  console.log(`Found ${songs.length} unique songs to add.\n`);

  // Authenticate
  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: "v3", auth });

  // Create playlist
  const today = new Date().toISOString().split("T")[0];
  const playlistTitle = `Shared Songs - Week of ${today}`;

  console.log(`Creating playlist: "${playlistTitle}"...`);

  const playlistResponse = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: playlistTitle,
        description: "Songs shared in Slack this week, auto-generated by songlink-bot.",
      },
      status: {
        privacyStatus: "unlisted", // or "public" / "private"
      },
    },
  });

  const playlistId = playlistResponse.data.id;
  console.log(`Created playlist: https://youtube.com/playlist?list=${playlistId}\n`);

  // Add videos to playlist
  console.log("Adding songs to playlist...\n");

  let added = 0;
  let failed = 0;

  for (const song of songs) {
    try {
      await youtube.playlistItems.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: "youtube#video",
              videoId: song.videoId,
            },
          },
        },
      });
      console.log(`  ✓ ${song.title || song.videoId}`);
      added++;

      // Rate limit: YouTube API has quotas
      await new Promise((r) => setTimeout(r, 200));
    } catch (error: any) {
      console.log(`  ✗ ${song.title || song.videoId}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\nDone! Added ${added} songs, ${failed} failed.`);
  console.log(`Playlist URL: https://youtube.com/playlist?list=${playlistId}`);
}

main().catch(console.error);
