import {
  createAvatarHandler,
  createInteractiveSource,
  findChannelAvatar,
  saveChannelAvatar,
} from '@/channels';
import { USER_AGENT } from '@/collector/http';
import { getDb } from '@/db';

export const runtime = 'nodejs';
// Responses carry their own s-maxage; the route must still run per request on a cache miss.
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

let handle: ReturnType<typeof createAvatarHandler> | undefined;

const avatarHandler = () =>
  (handle ??= createAvatarHandler({
    findAvatarUrl: (username) => findChannelAvatar(getDb(), username),
    saveAvatarUrl: (username, url) => saveChannelAvatar(getDb(), username, url),
    fetchChannelInfo: (username) => createInteractiveSource().fetchChannelInfo(username),
    fetchImage: (url) =>
      fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      }),
    log: console.log,
  }));

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ username: string }> },
): Promise<Response> {
  const { username } = await ctx.params;
  return avatarHandler()(username);
}
