import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, youtube_v3 } from 'googleapis';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Multi-project configuration ────────────────────────────────────────────

interface ProjectConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

const MCP_DIR = path.join(os.homedir(), '.youtube-mcp');
const CREDS_PATH = path.join(MCP_DIR, 'credentials.json');
const STATE_PATH = path.join(MCP_DIR, 'state.json');

if (!fs.existsSync(MCP_DIR)) fs.mkdirSync(MCP_DIR, { recursive: true });

// Migrate legacy token file if present
const LEGACY_TOKEN = path.join(os.homedir(), '.youtube-mcp-tokens.json');

function tokenPath(index: number): string {
  return path.join(MCP_DIR, `tokens-${index}.json`);
}

// Load or initialise credentials from file, falling back to env vars
function loadProjects(): ProjectConfig[] {
  if (fs.existsSync(CREDS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')) as ProjectConfig[];
    } catch {
      console.error('Failed to parse credentials.json — falling back to env vars.');
    }
  }
  // Fallback: single project from env vars
  const id = process.env.YOUTUBE_CLIENT_ID;
  const secret = process.env.YOUTUBE_CLIENT_SECRET;
  const key = process.env.YOUTUBE_API_KEY;
  if (id && secret && key) {
    return [{ name: 'default', clientId: id, clientSecret: secret, apiKey: key }];
  }
  return [];
}

function loadState(): number {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).activeIndex ?? 0;
    } catch { /* ignore */ }
  }
  return 0;
}

function saveState(index: number): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ activeIndex: index }, null, 2));
}

const projects = loadProjects();

if (projects.length === 0) {
  console.error('No YouTube credentials found. Add ~/.youtube-mcp/credentials.json or set YOUTUBE_CLIENT_ID/SECRET/API_KEY env vars.');
  process.exit(1);
}

let activeProjectIndex = Math.min(loadState(), projects.length - 1);

// ─── OAuth & YouTube client state ────────────────────────────────────────────

let oauth2Client: OAuth2Client | null = null;
let authenticatedYoutube: youtube_v3.Youtube | null = null;
let youtube = google.youtube({ version: 'v3', auth: projects[activeProjectIndex].apiKey });

function initProject(index: number): void {
  const proj = projects[index];
  youtube = google.youtube({ version: 'v3', auth: proj.apiKey });
  oauth2Client = new google.auth.OAuth2(proj.clientId, proj.clientSecret, 'http://localhost');
  authenticatedYoutube = null;

  // Migrate legacy token file to project slot if this is the only project
  if (index === 0 && projects.length === 1 && fs.existsSync(LEGACY_TOKEN) && !fs.existsSync(tokenPath(0))) {
    fs.copyFileSync(LEGACY_TOKEN, tokenPath(0));
    console.error('Migrated legacy token file to ~/.youtube-mcp/tokens-0.json');
  }

  const tp = tokenPath(index);
  if (fs.existsSync(tp)) {
    try {
      const saved = JSON.parse(fs.readFileSync(tp, 'utf8'));
      oauth2Client.setCredentials(saved);
      oauth2Client.on('tokens', (refreshed) => {
        const current = JSON.parse(fs.readFileSync(tp, 'utf8'));
        fs.writeFileSync(tp, JSON.stringify({ ...current, ...refreshed }, null, 2));
      });
      authenticatedYoutube = google.youtube({ version: 'v3', auth: oauth2Client });
      console.error(`Project ${index + 1} (${proj.name}): tokens loaded.`);
    } catch {
      console.error(`Project ${index + 1} (${proj.name}): failed to load tokens — re-auth required.`);
    }
  } else {
    console.error(`Project ${index + 1} (${proj.name}): no tokens found — re-auth required.`);
  }
}

// Migrate legacy single token file to the correct project slot
if (fs.existsSync(LEGACY_TOKEN)) {
  // Find which project index this token belongs to (use last known active project)
  const legacyTarget = tokenPath(activeProjectIndex);
  if (!fs.existsSync(legacyTarget)) {
    fs.copyFileSync(LEGACY_TOKEN, legacyTarget);
    console.error(`Migrated legacy token → tokens-${activeProjectIndex}.json`);
  }
}

initProject(activeProjectIndex);

// ─── Quota rotation ──────────────────────────────────────────────────────────

function isQuotaError(err: any): boolean {
  return (
    err?.status === 403 ||
    err?.code === 403 ||
    (err?.message ?? '').toLowerCase().includes('quota')
  );
}

function rotateToNextProject(): boolean {
  const start = activeProjectIndex;
  for (let i = 1; i < projects.length; i++) {
    const next = (start + i) % projects.length;
    if (fs.existsSync(tokenPath(next))) {
      console.error(`Rotating from project ${start + 1} to project ${next + 1} (${projects[next].name})`);
      activeProjectIndex = next;
      saveState(next);
      initProject(next);
      return true;
    }
  }
  console.error('All projects exhausted or have no tokens.');
  return false;
}

async function ytCall<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < projects.length; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      if (isQuotaError(err) && attempt < projects.length - 1) {
        const rotated = rotateToNextProject();
        if (!rotated) throw err;
      } else {
        throw err;
      }
    }
  }
  throw new Error('All projects quota exhausted');
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'youtube-playlist-manager',
  version: '2.0.0',
});

function isOAuthConfigured(): boolean {
  return oauth2Client !== null && authenticatedYoutube !== null;
}

function getAuthUrl(): string {
  if (!oauth2Client) throw new Error('OAuth client not configured.');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ],
  });
}

// ─── Tool: authenticate_youtube ──────────────────────────────────────────────

server.tool(
  'authenticate_youtube',
  'Authenticate with YouTube OAuth. Use getAuthUrl=true to get the URL, then call again with authCode.',
  {
    authCode: z.string().optional().describe('Authorization code from the OAuth redirect URL'),
    getAuthUrl: z.boolean().default(false).describe('Set true to get the authorization URL'),
    projectIndex: z.number().min(0).optional().describe('Project index to authenticate (0-based, default: active project)'),
  },
  async ({ authCode, getAuthUrl: shouldGetAuthUrl, projectIndex }) => {
    const targetIndex = projectIndex ?? activeProjectIndex;
    const proj = projects[targetIndex];

    if (!proj) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project index ${targetIndex} not found. Available: 0-${projects.length - 1}` }) }] };
    }

    // Temporarily init target project for auth URL generation / token exchange
    if (targetIndex !== activeProjectIndex) {
      activeProjectIndex = targetIndex;
      saveState(targetIndex);
      initProject(targetIndex);
    }

    if (!oauth2Client) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'OAuth not configured for this project.' }) }] };
    }

    if (shouldGetAuthUrl) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            project: proj.name,
            projectIndex: targetIndex,
            authUrl: getAuthUrl(),
            instructions: [
              '1. Open the URL in your browser',
              '2. Sign in and grant permissions',
              '3. You will be redirected to http://localhost (page may not load — that is OK)',
              '4. Copy the "code" value from the URL bar (between "code=" and "&")',
              '5. Call this tool again with authCode',
            ],
          }, null, 2),
        }],
      };
    }

    if (!authCode) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide getAuthUrl=true or authCode.' }) }] };
    }

    try {
      const { tokens } = await oauth2Client.getToken(authCode);
      oauth2Client.setCredentials(tokens);

      const tp = tokenPath(targetIndex);
      fs.writeFileSync(tp, JSON.stringify(tokens, null, 2));

      oauth2Client.on('tokens', (refreshed) => {
        const current = JSON.parse(fs.readFileSync(tp, 'utf8'));
        fs.writeFileSync(tp, JSON.stringify({ ...current, ...refreshed }, null, 2));
      });

      authenticatedYoutube = google.youtube({ version: 'v3', auth: oauth2Client });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            project: proj.name,
            projectIndex: targetIndex,
            message: 'Authenticated successfully. Tokens saved — will persist across restarts.',
            expires: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'Unknown',
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication failed', message: error instanceof Error ? error.message : String(error) }) }] };
    }
  }
);

// ─── Tool: get_project_status ────────────────────────────────────────────────

server.tool(
  'get_project_status',
  'Show all configured Google Cloud projects, which is active, and which have valid tokens',
  {},
  async () => {
    const status = projects.map((p, i) => ({
      index: i,
      name: p.name,
      active: i === activeProjectIndex,
      hasTokens: fs.existsSync(tokenPath(i)),
      authenticated: i === activeProjectIndex ? isOAuthConfigured() : fs.existsSync(tokenPath(i)),
    }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ activeProjectIndex, activeProject: projects[activeProjectIndex].name, projects: status }, null, 2),
      }],
    };
  }
);

// ─── Tool: switch_project ────────────────────────────────────────────────────

server.tool(
  'switch_project',
  'Manually switch to a specific Google Cloud project by index',
  { projectIndex: z.number().min(0).describe('Project index to switch to (0-based)') },
  async ({ projectIndex }) => {
    if (projectIndex >= projects.length) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Index ${projectIndex} out of range. Available: 0-${projects.length - 1}` }) }] };
    }
    activeProjectIndex = projectIndex;
    saveState(projectIndex);
    initProject(projectIndex);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ success: true, activeProject: projects[projectIndex].name, projectIndex, authenticated: isOAuthConfigured() }, null, 2),
      }],
    };
  }
);

// ─── Tool: search_music_videos ───────────────────────────────────────────────

server.tool(
  'search_music_videos',
  'Search YouTube for music videos',
  {
    query: z.string().describe('Search query for music videos'),
    maxResults: z.number().min(1).max(50).default(10).describe('Maximum number of results to return'),
    order: z.enum(['relevance', 'date', 'rating', 'viewCount', 'title']).default('relevance').describe('Sort order'),
  },
  async ({ query, maxResults, order }) => {
    try {
      const response = await youtube.search.list({
        part: ['snippet'],
        q: `${query} music video`,
        type: ['video'],
        videoCategoryId: '10',
        maxResults,
        order,
        videoEmbeddable: 'true',
        safeSearch: 'none',
      });
      const videos = response.data.items?.map((item) => ({
        videoId: item.id?.videoId,
        title: item.snippet?.title,
        channelTitle: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt,
        url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
      })) || [];
      return { content: [{ type: 'text', text: JSON.stringify({ videos }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ─── Tool: create_playlist ───────────────────────────────────────────────────

server.tool(
  'create_playlist',
  'Create a new YouTube playlist',
  {
    title: z.string().describe('Playlist title'),
    description: z.string().optional().describe('Playlist description'),
    privacy: z.enum(['private', 'public', 'unlisted']).default('private').describe('Privacy setting'),
  },
  async ({ title, description, privacy }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required. Use authenticate_youtube.' }) }] };
    try {
      const response = await ytCall(() => authenticatedYoutube!.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: { snippet: { title, description: description || '' }, status: { privacyStatus: privacy } },
      }));
      const p = response.data;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, playlist: { id: p.id, title: p.snippet?.title, privacy: p.status?.privacyStatus, url: `https://www.youtube.com/playlist?list=${p.id}` } }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to create playlist', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: edit_playlist ─────────────────────────────────────────────────────

server.tool(
  'edit_playlist',
  'Edit playlist title, description, or privacy',
  {
    playlistId: z.string().describe('Playlist ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    privacy: z.enum(['private', 'public', 'unlisted']).optional().describe('New privacy setting'),
  },
  async ({ playlistId, title, description, privacy }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    if (!title && !description && !privacy) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide at least one of: title, description, privacy.' }) }], isError: true };
    try {
      const current = await ytCall(() => authenticatedYoutube!.playlists.list({ part: ['snippet', 'status'], id: [playlistId] }));
      if (!current.data.items?.length) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Playlist not found.' }) }], isError: true };
      const existing = current.data.items[0];
      const updateBody: any = { id: playlistId, snippet: { title: title || existing.snippet?.title, description: description !== undefined ? description : existing.snippet?.description } };
      const parts = ['snippet'];
      if (privacy) { updateBody.status = { privacyStatus: privacy }; parts.push('status'); }
      const response = await ytCall(() => authenticatedYoutube!.playlists.update({ part: parts, requestBody: updateBody }));
      const p = response.data;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, playlist: { id: p.id, title: p.snippet?.title, privacy: p.status?.privacyStatus } }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to edit playlist', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: add_to_playlist ───────────────────────────────────────────────────

server.tool(
  'add_to_playlist',
  'Add a video to a YouTube playlist',
  {
    playlistId: z.string().describe('Playlist ID'),
    videoId: z.string().describe('YouTube video ID'),
  },
  async ({ playlistId, videoId }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      const response = await ytCall(() => authenticatedYoutube!.playlistItems.insert({
        part: ['snippet'],
        requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      }));
      const item = response.data;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, playlistItemId: item.id, position: item.snippet?.position }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to add video', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: list_playlists ────────────────────────────────────────────────────

server.tool(
  'list_playlists',
  "List the authenticated user's YouTube playlists",
  { maxResults: z.number().min(1).max(50).default(50).describe('Max results') },
  async ({ maxResults }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      const response = await ytCall(() => authenticatedYoutube!.playlists.list({
        part: ['snippet', 'contentDetails', 'status'],
        mine: true,
        maxResults,
      }));
      const playlists = response.data.items?.map((p) => ({
        id: p.id,
        title: p.snippet?.title,
        itemCount: p.contentDetails?.itemCount,
        privacy: p.status?.privacyStatus,
        url: `https://www.youtube.com/playlist?list=${p.id}`,
      })) || [];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, total: response.data.pageInfo?.totalResults, playlists }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to list playlists', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: get_playlist_items ────────────────────────────────────────────────

server.tool(
  'get_playlist_items',
  'Get videos from a YouTube playlist',
  {
    playlistId: z.string().describe('Playlist ID'),
    maxResults: z.number().min(1).max(50).default(50).describe('Max results'),
  },
  async ({ playlistId, maxResults }) => {
    try {
      const client = isOAuthConfigured() ? authenticatedYoutube! : youtube;
      const response = await ytCall(() => client.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId, maxResults }));
      const items = response.data.items?.map((item) => ({
        playlistItemId: item.id,
        videoId: item.contentDetails?.videoId,
        title: item.snippet?.title,
        channelTitle: item.snippet?.videoOwnerChannelTitle,
        position: item.snippet?.position,
        url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`,
      })) || [];
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, playlistId, itemCount: items.length, totalResults: response.data.pageInfo?.totalResults, items }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ─── Tool: get_video_details ─────────────────────────────────────────────────

server.tool(
  'get_video_details',
  'Get detailed information about a YouTube video',
  { videoId: z.string().describe('YouTube video ID') },
  async ({ videoId }) => {
    try {
      const response = await youtube.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: [videoId] });
      const video = response.data.items?.[0];
      if (!video) return { content: [{ type: 'text', text: `No video found with ID: ${videoId}` }], isError: true };
      const s = video.snippet;
      const st = video.statistics;
      const cd = video.contentDetails;
      return {
        content: [{
          type: 'text',
          text: `**${s?.title}**\nChannel: ${s?.channelTitle}\nPublished: ${s?.publishedAt}\nDuration: ${cd?.duration}\nViews: ${st?.viewCount}\nLikes: ${st?.likeCount}\n\n${s?.description}\n\nURL: https://www.youtube.com/watch?v=${videoId}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ─── Tool: get_auth_status ───────────────────────────────────────────────────

server.tool(
  'get_auth_status',
  'Check authentication status and active project',
  {},
  async () => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          authenticated: isOAuthConfigured(),
          activeProject: projects[activeProjectIndex]?.name,
          activeProjectIndex,
          totalProjects: projects.length,
          message: isOAuthConfigured()
            ? `Authenticated on project ${activeProjectIndex + 1} (${projects[activeProjectIndex]?.name})`
            : 'Not authenticated. Use authenticate_youtube.',
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: remove_from_playlist ──────────────────────────────────────────────

server.tool(
  'remove_from_playlist',
  'Remove a video from a playlist by playlist item ID',
  { playlistItemId: z.string().describe('Playlist item ID (from get_playlist_items, not the video ID)') },
  async ({ playlistItemId }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      await ytCall(() => authenticatedYoutube!.playlistItems.delete({ id: playlistItemId }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, playlistItemId }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to remove video', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: delete_playlist ───────────────────────────────────────────────────

server.tool(
  'delete_playlist',
  'Permanently delete a YouTube playlist',
  { playlistId: z.string().describe('Playlist ID to delete') },
  async ({ playlistId }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      await ytCall(() => authenticatedYoutube!.playlists.delete({ id: playlistId }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, playlistId }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to delete playlist', message: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: list_my_channels ──────────────────────────────────────────────────

server.tool(
  'list_my_channels',
  'List all YouTube channels on the authenticated Google account',
  {},
  async () => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      const response = await ytCall(() => authenticatedYoutube!.channels.list({ part: ['snippet', 'contentDetails', 'statistics'], mine: true, maxResults: 50 }));
      const channels = response.data.items?.map((c) => ({ id: c.id, title: c.snippet?.title, customUrl: c.snippet?.customUrl, subscriberCount: c.statistics?.subscriberCount, videoCount: c.statistics?.videoCount })) || [];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channels }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Tool: list_channel_playlists ────────────────────────────────────────────

server.tool(
  'list_channel_playlists',
  'List playlists for a specific YouTube channel by ID',
  {
    channelId: z.string().describe('YouTube channel ID'),
    maxResults: z.number().min(1).max(50).default(50).describe('Max results'),
  },
  async ({ channelId, maxResults }) => {
    if (!isOAuthConfigured()) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required.' }) }] };
    try {
      const response = await ytCall(() => authenticatedYoutube!.playlists.list({ part: ['snippet', 'contentDetails', 'status'], channelId, maxResults }));
      const playlists = response.data.items?.map((p) => ({ id: p.id, title: p.snippet?.title, itemCount: p.contentDetails?.itemCount, privacy: p.status?.privacyStatus, url: `https://www.youtube.com/playlist?list=${p.id}` })) || [];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, totalResults: response.data.pageInfo?.totalResults, playlists }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  }
);

// ─── Start server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`YouTube Playlist Manager MCP v2.0 running — ${projects.length} project(s) configured, active: ${projects[activeProjectIndex].name}`);
}

process.on('SIGINT', async () => { await server.close(); process.exit(0); });
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });

main().catch((error) => { console.error('Fatal error:', error); process.exit(1); });
