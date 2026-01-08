import { Hono } from "hono";
import type {
  Env,
  SlackEvent,
  SlackMessageEvent,
  SongLinkResponse,
} from "./types";

const app = new Hono<{ Bindings: Env }>();

const MUSIC_URL_REGEX =
  /(https?:\/\/)?(open\.spotify\.com|tidal\.com|music\.youtube\.com|youtu\.be|youtube\.com\/watch)\/[^\s]+/gi;

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
      handleMusicLinks(event.event, c.env.SLACK_BOT_TOKEN),
    );
  }

  return c.text("OK");
});

async function handleMusicLinks(
  message: SlackMessageEvent,
  botToken: string,
): Promise<void> {
  const matches = message.text.match(MUSIC_URL_REGEX);

  if (!matches) return;

  for (const url of matches) {
    try {
      // Call song.link API
      const response = await fetch(
        `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}`,
      );

      if (!response.ok) {
        console.error("song.link API error:", response.status);
        continue;
      }

      const data: SongLinkResponse = await response.json();
      const songLink = data.pageUrl;

      // Post to Slack
      const slackResponse = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: message.channel,
          text: `🎵 ${songLink}`,
          thread_ts: message.ts,
        }),
      });

      if (!slackResponse.ok) {
        console.error("Slack API HTTP error:", slackResponse.status);
        continue;
      }

      const slackData = await slackResponse.json();
      if (!slackData.ok) {
        console.error("Slack API error:", slackData.error);
      }
    } catch (error) {
      console.error("Error processing music link:", error);
    }
  }
}

export default app;
