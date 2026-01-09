/**
 * One-time backfill script to import songs shared in the past week.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/backfill.ts <channel_id1> [channel_id2] ...
 *
 * Or set channels via env:
 *   SLACK_BOT_TOKEN=xoxb-... CHANNELS=C123,C456 npx tsx scripts/backfill.ts
 */

const MUSIC_URL_REGEX =
  /(https?:\/\/)?(open\.spotify\.com|music\.apple\.com|itunes\.apple\.com|youtube\.com|youtu\.be|music\.youtube\.com|play\.google\.com|pandora\.com|deezer\.com|tidal\.com|amazon\.com\/music|music\.amazon\.com|soundcloud\.com|(?:web\.)?napster\.com|music\.yandex\.(?:com|ru)|spinrilla\.com|audius\.co|anghami\.com|boomplay\.com|audiomack\.com|[\w-]+\.bandcamp\.com|bandcamp\.com)\/[^\s>]+/gi;

interface SlackMessage {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

interface SongLinkResponse {
  pageUrl: string;
  entityUniqueId: string;
  linksByPlatform?: {
    youtube?: { url: string };
    youtubeMusic?: { url: string };
  };
  entitiesByUniqueId?: {
    [key: string]: {
      artistName?: string;
      title?: string;
    };
  };
}

interface SharedSong {
  original_url: string;
  songlink_url?: string;
  youtube_url?: string;
  title?: string;
  shared_by: string;
  channel: string;
  message_ts: string;
  shared_at: string;
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) {
  console.error("Error: SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}

// Get channels from args or env
const channelIds =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : (process.env.CHANNELS?.split(",").map((c) => c.trim()) ?? []);

if (channelIds.length === 0) {
  console.error("Error: No channel IDs provided");
  console.error(
    "Usage: SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/backfill.ts <channel_id1> [channel_id2] ...",
  );
  process.exit(1);
}

// Calculate timestamp for 7 days ago
const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

async function fetchChannelHistory(channelId: string): Promise<SlackMessage[]> {
  const allMessages: SlackMessage[] = [];
  let cursor: string | undefined;

  console.log(`Fetching history for channel ${channelId}...`);

  do {
    const params = new URLSearchParams({
      channel: channelId,
      oldest: oneWeekAgo.toString(),
      limit: "200",
    });
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
      },
    );

    const data: SlackHistoryResponse = await response.json();

    if (!data.ok) {
      console.error(`Error fetching channel ${channelId}: ${data.error}`);
      break;
    }

    if (data.messages) {
      // Filter out bot messages
      const userMessages = data.messages.filter((m) => m.user && !m.bot_id);
      allMessages.push(...userMessages);
    }

    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  console.log(`  Found ${allMessages.length} user messages`);
  return allMessages;
}

async function getSongLinkData(
  url: string,
): Promise<Partial<SongLinkResponse> | null> {
  try {
    const response = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}`,
    );

    if (!response.ok) {
      console.log(`  song.link API error for ${url}: ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.log(`  Error fetching song.link data: ${error}`);
    return null;
  }
}

function tsToISODate(ts: string): string {
  const timestamp = parseFloat(ts) * 1000;
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

async function main() {
  console.log(`\nBackfilling songs from the past 7 days...`);
  console.log(`Channels to scan: ${channelIds.join(", ")}\n`);

  const songs: SharedSong[] = [];
  const seenUrls = new Set<string>();

  for (const channelId of channelIds) {
    const messages = await fetchChannelHistory(channelId);

    for (const message of messages) {
      if (!message.text || !message.user) continue;

      const matches = message.text.match(MUSIC_URL_REGEX);
      if (!matches) continue;

      for (const url of matches) {
        // Clean URL (remove Slack's wrapping)
        const cleanUrl = url.replace(/^<|>$/g, "").split("|")[0];

        // Dedupe by URL + message
        const dedupeKey = `${channelId}:${message.ts}:${cleanUrl}`;
        if (seenUrls.has(dedupeKey)) continue;
        seenUrls.add(dedupeKey);

        console.log(`Processing: ${cleanUrl.slice(0, 60)}...`);

        // Rate limit: be nice to song.link API
        await new Promise((r) => setTimeout(r, 500));

        const songData = await getSongLinkData(cleanUrl);

        const youtubeUrl =
          songData?.linksByPlatform?.youtube?.url ||
          songData?.linksByPlatform?.youtubeMusic?.url;

        let title: string | undefined;
        if (songData?.entitiesByUniqueId && songData.entityUniqueId) {
          const entity = songData.entitiesByUniqueId[songData.entityUniqueId];
          if (entity?.artistName && entity?.title) {
            title = `${entity.artistName} - ${entity.title}`;
          }
        }

        songs.push({
          original_url: cleanUrl,
          songlink_url: songData?.pageUrl,
          youtube_url: youtubeUrl,
          title,
          shared_by: message.user,
          channel: channelId,
          message_ts: message.ts,
          shared_at: tsToISODate(message.ts),
        });
      }
    }
  }

  console.log(`\nFound ${songs.length} songs to import.\n`);

  if (songs.length === 0) {
    console.log("No songs to import.");
    return;
  }

  // Output SQL statements to import via wrangler
  console.log("=".repeat(60));
  console.log("Run the following command to import into D1:");
  console.log("=".repeat(60));
  console.log(
    `\nwrangler d1 execute songlink-shares --remote --file=scripts/backfill.sql\n`,
  );

  // Generate SQL file
  const sqlStatements = songs.map((song) => {
    const escape = (s?: string) =>
      s ? `'${s.replace(/'/g, "''")}'` : "NULL";
    return `INSERT OR IGNORE INTO shared_songs (original_url, songlink_url, youtube_url, title, shared_by, channel, message_ts, shared_at) VALUES (${escape(song.original_url)}, ${escape(song.songlink_url)}, ${escape(song.youtube_url)}, ${escape(song.title)}, ${escape(song.shared_by)}, ${escape(song.channel)}, ${escape(song.message_ts)}, ${escape(song.shared_at)});`;
  });

  const sqlContent = sqlStatements.join("\n");

  // Write to file
  const fs = await import("fs/promises");
  await fs.writeFile("scripts/backfill.sql", sqlContent);
  console.log(`Generated scripts/backfill.sql with ${songs.length} INSERT statements.`);

  // Also print summary
  console.log("\nSongs found:");
  for (const song of songs) {
    console.log(`  - ${song.title || song.original_url.slice(0, 50)}`);
  }
}

main().catch(console.error);
