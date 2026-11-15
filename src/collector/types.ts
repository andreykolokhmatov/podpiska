export interface ChannelInfo {
  /** Lowercase, as stored in `channels.username`. */
  username: string;
  /** Original casing as shown by Telegram. */
  displayUsername: string;
  title: string | null;
  avatarUrl: string | null;
}

export interface ParsedPost {
  tgPostId: number;
  text: string | null;
  html: string | null;
  publishedAt: Date;
  views: number | null;
  hasMedia: boolean;
}

export interface ChannelFetchResult {
  info: ChannelInfo;
  posts: ParsedPost[];
}

/** The only seam for swapping the web-preview scraper for MTProto. */
export interface PostSource {
  fetchChannel(username: string, since: Date): Promise<ChannelFetchResult>;
  fetchChannelInfo(username: string): Promise<ChannelInfo>;
}
