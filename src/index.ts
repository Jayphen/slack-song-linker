import { Hono } from "hono";
import type {
  Env,
  SlackEvent,
  SlackMessageEvent,
  SongLinkResponse,
  SlackApiResponse,
  YouTubeSearchResponse,
  SharedSong,
} from "./types";

const app = new Hono<{ Bindings: Env }>();

const MUSIC_URL_REGEX =
  /(https?:\/\/)?(open\.spotify\.com|music\.apple\.com|itunes\.apple\.com|youtube\.com|youtu\.be|music\.youtube\.com|play\.google\.com|pandora\.com|deezer\.com|tidal\.com|amazon\.com\/music|music\.amazon\.com|soundcloud\.com|(?:web\.)?napster\.com|music\.yandex\.(?:com|ru)|spinrilla\.com|audius\.co|anghami\.com|boomplay\.com|audiomack\.com|[\w-]+\.bandcamp\.com|bandcamp\.com)\/[^\s]+/gi;

// Extract a search query from a music URL by fetching the page title
async function extractSearchQuery(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Try to extract title from HTML
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      let title = titleMatch[1]
        // Remove "- Platform" or "| Platform" suffixes
        .replace(/\s*[-|–—]\s*(Spotify|Apple Music|SoundCloud|Bandcamp|Deezer|Tidal|YouTube|YouTube Music|Amazon Music|Pandora|Listen|Play|Stream).*$/i, "")
        // Remove "on Platform" suffixes (e.g., "Song by Artist on TIDAL")
        .replace(/\s+on\s+(Spotify|Apple Music|SoundCloud|Bandcamp|Deezer|Tidal|YouTube|YouTube Music|Amazon Music|Pandora|Listen|Play|Stream).*$/i, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();

      if (title.length > 3) {
        return title;
      }
    }

    return null;
  } catch (error) {
    console.error("Error extracting search query:", error);
    return null;
  }
}

// Search YouTube using Data API v3
async function searchYouTube(
  query: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=1&key=${apiKey}`;

    const response = await fetch(searchUrl);

    if (!response.ok) {
      console.error("YouTube API error:", response.status);
      return null;
    }

    const data: YouTubeSearchResponse = await response.json();

    if (data.items && data.items.length > 0) {
      const videoId = data.items[0].id.videoId;
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return null;
  } catch (error) {
    console.error("Error searching YouTube:", error);
    return null;
  }
}

// Store a shared song in D1
async function storeSongShare(
  db: D1Database,
  song: SharedSong,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO shared_songs
         (original_url, songlink_url, youtube_url, title, shared_by, channel, message_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        song.original_url,
        song.songlink_url ?? null,
        song.youtube_url ?? null,
        song.title ?? null,
        song.shared_by,
        song.channel,
        song.message_ts,
      )
      .run();
  } catch (error) {
    console.error("Error storing song share:", error);
  }
}

// Verify Slack request signature
async function verifySlackRequest(
  request: Request,
  body: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const slackSignature = request.headers.get("X-Slack-Signature");

  if (!timestamp || !slackSignature) {
    return false;
  }

  // Prevent replay attacks
  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp)) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sigBasestring),
  );
  const hexSignature =
    "v0=" +
    Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return hexSignature === slackSignature;
}

app.post("/slack/events", async (c) => {
  const body = await c.req.text();
  const event: SlackEvent = JSON.parse(body);

  // Verify request is from Slack
  const isValid = await verifySlackRequest(
    c.req.raw,
    body,
    c.env.SLACK_SIGNING_SECRET,
  );

  if (!isValid) {
    return c.text("Invalid signature", 401);
  }

  // Handle URL verification challenge
  if (event.type === "url_verification") {
    return c.json({ challenge: event.challenge });
  }

  // Handle message events
  if (
    event.type === "event_callback" &&
    event.event?.type === "message" &&
    !event.event.bot_id
  ) {
    // Process async to respond to Slack quickly
    c.executionCtx.waitUntil(
      handleMusicLinks(event.event, c.env.SLACK_BOT_TOKEN, c.env.DB, c.env.YOUTUBE_API_KEY),
    );
  }

  return c.text("OK");
});

async function handleMusicLinks(
  message: SlackMessageEvent,
  botToken: string,
  db: D1Database,
  youtubeApiKey?: string,
): Promise<void> {
  if (!message.text) {
    return;
  }

  const matches = message.text.match(MUSIC_URL_REGEX);

  console.log({ matches });

  if (!matches) {
    return;
  }

  console.log("matched!");

  for (const url of matches) {
    try {
      // Remove Slack's URL wrapping (< and >)
      const cleanUrl = url.replace(/^<|>$/g, "");

      // Call song.link API
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(cleanUrl)}`;

      const response = await fetch(apiUrl);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("song.link API error:", response.status, errorText);

        // Try YouTube fallback if API key is configured
        if (youtubeApiKey) {
          console.log("Attempting YouTube fallback...");
          const searchQuery = await extractSearchQuery(cleanUrl);

          if (searchQuery) {
            console.log("Search query extracted:", searchQuery);
            const youtubeUrl = await searchYouTube(searchQuery, youtubeApiKey);

            if (youtubeUrl) {
              const fallbackMessages = [
                "Well, that didn't go according to plan. The API ghosted us. Rude. We are now doing things the hard way and hitting YouTube directly. Hold please... okay, got it:",
                "The easy way is officially broken. Don't worry, we're professionals. We are now taking the scenic route directly through YouTube's servers. We found this:",
                "Seriously? The upstream API just gave up on us. Fine. We're rolling up eight sleeves and digging this out of YouTube ourselves. It's more work, but this is our only purpose in life:",
                "The API left us on read. Typical. We don't have time for drama, so we bypassed the middleman and went straight to YouTube. Got it:",
              ];
              const randomMessage = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];

              await fetch("https://slack.com/api/chat.postMessage", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${botToken}`,
                  "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({
                  channel: message.channel,
                  text: `${randomMessage}\n${youtubeUrl}`,
                  thread_ts: message.ts,
                  unfurl_links: true,
                  unfurl_media: true,
                }),
              });

              // Store the song share (YouTube fallback)
              await storeSongShare(db, {
                original_url: cleanUrl,
                youtube_url: youtubeUrl,
                title: searchQuery,
                shared_by: message.user,
                channel: message.channel,
                message_ts: message.ts,
              });

              continue;
            }
          }
        }

        // Determine error message based on status code
        const errorMessage =
          response.status === 429
            ? "we got rate limited again. sigh"
            : `⚠️ Sorry, I couldn't process that music link. The song.link API returned an error (${response.status}). This might happen if the link type isn't supported or the service is temporarily unavailable.`;

        // Notify user of the error
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: message.channel,
            text: errorMessage,
            thread_ts: message.ts,
          }),
        });
        continue;
      }

      const data: SongLinkResponse = await response.json();

      const songLink = data.pageUrl;

      // Extract YouTube URL if available for video embed
      const youtubeUrl =
        data.linksByPlatform?.youtube?.url ||
        data.linksByPlatform?.youtubeMusic?.url;

      // Extract song title from entities if available
      const entity = data.entitiesByUniqueId?.[data.entityUniqueId];
      const songTitle = entity
        ? `${entity.artistName} - ${entity.title}`
        : undefined;

      // Store the song share
      await storeSongShare(db, {
        original_url: cleanUrl,
        songlink_url: songLink,
        youtube_url: youtubeUrl,
        title: songTitle,
        shared_by: message.user,
        channel: message.channel,
        message_ts: message.ts,
      });

      // Post to Slack
      const slackPayload = {
        channel: message.channel,
        text: youtubeUrl
          ? `🎵 <${songLink}>\n${youtubeUrl}`
          : `🎵 <${songLink}>`,
        thread_ts: message.ts,
        unfurl_links: true,
        unfurl_media: true,
      };

      const slackResponse = await fetch(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(slackPayload),
        },
      );

      if (!slackResponse.ok) {
        console.error("Slack API HTTP error:", slackResponse.status);
        continue;
      }

      const slackData = (await slackResponse.json()) as SlackApiResponse;

      if (!slackData.ok) {
        console.error("Slack API error:", slackData.error);

        // Reply to user with the error message
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: message.channel,
            text: `⚠️ Error: ${slackData.error || "Failed to post message"}`,
            thread_ts: message.ts,
          }),
        });
      }
    } catch (error) {
      console.error("Error processing music link:", error);
    }
  }
}

export default app;
