# Slack Songlink Bot

A Slack bot that automatically detects music links from various streaming platforms (Spotify, Apple Music, YouTube, etc.) and responds with a universal [song.link](https://song.link) URL that works across all platforms. When available, it also includes a YouTube embed for easy playback.

## Features

- Detects music URLs from 20+ streaming platforms including:
  - Spotify
  - Apple Music
  - YouTube / YouTube Music
  - SoundCloud
  - Tidal
  - Deezer
  - Pandora
  - Amazon Music
  - Bandcamp
  - And more...
- Responds in thread with a universal song.link URL
- Includes YouTube video embed when available
- Request verification using Slack signing secret
- Runs on Cloudflare Workers (serverless, fast, free tier available)

## Prerequisites

- [Node.js](https://nodejs.org/) (v16 or later)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Slack workspace with admin permissions to install apps

## Setup

### 1. Clone and Install Dependencies

```bash
git clone <your-repo-url>
cd slack-songlink-bot
npm install
```

### 2. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name your app (e.g., "Songlink Bot") and select your workspace
4. Configure the following settings:

#### OAuth & Permissions
Add these Bot Token Scopes:
- `channels:history` - View messages in public channels
- `chat:write` - Send messages
- `groups:history` - View messages in private channels (optional)
- `im:history` - View messages in direct messages (optional)
- `mpim:history` - View messages in group DMs (optional)

Install the app to your workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### Event Subscriptions
1. Enable Events
2. Set Request URL to: `https://your-worker-name.your-subdomain.workers.dev/slack/events`
   - You'll need to deploy first and come back to this step (see deployment section)
3. Subscribe to bot events:
   - `message.channels`
   - `message.groups` (optional, for private channels)
   - `message.im` (optional, for DMs)
   - `message.mpim` (optional, for group DMs)

#### App Home
- Enable Messages Tab (optional)

5. Under **Basic Information**, copy your **Signing Secret**

### 3. Configure Environment Variables

#### For Local Development
Create a `.dev.vars` file in the project root:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
```

#### For Production (Cloudflare Workers)
Set secrets using Wrangler CLI:

```bash
npx wrangler secret put SLACK_BOT_TOKEN
# Paste your bot token when prompted

npx wrangler secret put SLACK_SIGNING_SECRET
# Paste your signing secret when prompted
```

### 4. Update wrangler.toml (Optional)

Edit `wrangler.toml` to customize the worker name if desired:

```toml
name = "slack-songlink-bot"  # Change this to your preferred worker name
```

## Development

Run the development server locally:

```bash
npm run dev
```

This starts a local server that you can use with a tool like [ngrok](https://ngrok.com/) to test with Slack:

```bash
ngrok http 8787
```

Use the ngrok URL as your Event Subscriptions Request URL in Slack.

## Deployment

### Deploy to Cloudflare Workers

```bash
npm run deploy
```

This will:
1. Build your worker
2. Deploy to Cloudflare Workers
3. Output your worker URL (e.g., `https://slack-songlink-bot.your-subdomain.workers.dev`)

### Update Slack Event Subscription URL

After deploying:
1. Go to your Slack app settings
2. Navigate to **Event Subscriptions**
3. Update the Request URL to: `https://your-worker-name.your-subdomain.workers.dev/slack/events`
4. Slack will verify the URL (you should see a green "Verified" checkmark)

## Usage

1. Invite the bot to channels where you want it to work:
   ```
   /invite @Songlink Bot
   ```

2. Post a message with a music streaming URL:
   ```
   Check out this song: https://open.spotify.com/track/...
   ```

3. The bot will respond in a thread with:
   ```
   🎵 https://song.link/...
   https://youtube.com/watch?v=...
   ```

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token from Slack app | `xoxb-123456...` |
| `SLACK_SIGNING_SECRET` | Yes | Signing Secret from Slack app for request verification | `a1b2c3d4e5...` |

## Supported Music Platforms

The bot detects URLs from:
- Spotify (`open.spotify.com`)
- Apple Music (`music.apple.com`, `itunes.apple.com`)
- YouTube (`youtube.com`, `youtu.be`, `music.youtube.com`)
- SoundCloud (`soundcloud.com`)
- Tidal (`tidal.com`)
- Deezer (`deezer.com`)
- Pandora (`pandora.com`)
- Amazon Music (`amazon.com/music`, `music.amazon.com`)
- Google Play Music (`play.google.com`)
- Napster (`napster.com`)
- Yandex Music (`music.yandex.com`, `music.yandex.ru`)
- Spinrilla (`spinrilla.com`)
- Audius (`audius.co`)
- Anghami (`anghami.com`)
- Boomplay (`boomplay.com`)
- Audiomack (`audiomack.com`)
- Bandcamp (`bandcamp.com`, `*.bandcamp.com`)

## Scripts

- `npm run dev` - Start development server
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run type-check` - Run TypeScript type checking

## Architecture

- **Runtime**: Cloudflare Workers (Edge computing)
- **Framework**: Hono (lightweight web framework)
- **API**: [song.link API](https://www.notion.so/Odesli-Song-Link-Page-Link-API-5dc87d0db6dc477085ef25e12b6e7bd4) for music link conversion
- **Language**: TypeScript

## Troubleshooting

### Bot doesn't respond to messages
- Verify the bot is invited to the channel
- Check that Event Subscriptions URL is correct and verified
- Ensure `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set correctly
- Check Cloudflare Workers logs: `npx wrangler tail`

### "Invalid signature" errors
- Verify `SLACK_SIGNING_SECRET` matches your Slack app
- Ensure system time is accurate (signature verification uses timestamps)

### song.link API errors
- The song.link API may occasionally be unavailable or rate-limited
- Check worker logs for specific error messages

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
