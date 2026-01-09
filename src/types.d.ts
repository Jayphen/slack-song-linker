export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  YOUTUBE_API_KEY?: string;
  DB: D1Database;
}

export interface SharedSong {
  original_url: string;
  songlink_url?: string;
  youtube_url?: string;
  title?: string;
  shared_by: string;
  channel: string;
  message_ts: string;
}

export interface SlackEvent {
  type: string;
  challenge?: string;
  event?: SlackMessageEvent;
}

export interface SlackMessageEvent {
  type: string;
  channel: string;
  user: string;
  text?: string;
  ts: string;
  bot_id?: string;
}

export interface SongLinkResponse {
  pageUrl: string;
  entityUniqueId: string;
  userCountry: string;
  linksByPlatform: {
    youtube?: {
      url: string;
      entityUniqueId: string;
    };
    youtubeMusic?: {
      url: string;
      entityUniqueId: string;
    };
    [key: string]: any;
  };
  entitiesByUniqueId: {
    [key: string]: any;
  };
}

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export interface YouTubeSearchResponse {
  items?: Array<{
    id: {
      videoId: string;
    };
    snippet: {
      title: string;
      channelTitle: string;
    };
  }>;
}
