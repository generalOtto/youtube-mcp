import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, youtube_v3 } from 'googleapis';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_KEY = process.env.YOUTUBE_API_KEY;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const TOKEN_PATH = path.join(os.homedir(), '.youtube-mcp-tokens.json');

if (!API_KEY) {
  console.error('YOUTUBE_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize YouTube API client with API key (for read-only operations)
const youtube = google.youtube({
  version: 'v3',
  auth: API_KEY,
});

// Initialize OAuth2 client for authenticated operations
let oauth2Client: OAuth2Client | null = null;
let authenticatedYoutube: youtube_v3.Youtube | null = null;

if (CLIENT_ID && CLIENT_SECRET) {
  oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'http://localhost' // For installed applications
  );

  // Load saved tokens on startup so auth persists across restarts
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(saved);
      authenticatedYoutube = google.youtube({ version: 'v3', auth: oauth2Client });
      console.error('YouTube OAuth tokens loaded from disk.');
    } catch {
      console.error('Failed to load saved tokens — re-authentication required.');
    }
  }
}

// Create MCP server
const server = new McpServer({
  name: 'youtube-playlist-generator',
  version: '1.0.0',
});

// Helper function to check if OAuth is configured and authenticated
function isOAuthConfigured(): boolean {
  return oauth2Client !== null && authenticatedYoutube !== null;
}

// Helper function to get OAuth authorization URL
function getAuthUrl(): string {
  if (!oauth2Client) {
    throw new Error(
      'OAuth client not configured. Please set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.'
    );
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ],
  });

  return authUrl;
}

// Tool: Authenticate with YouTube OAuth
server.tool(
  'authenticate_youtube',
  'Authenticate with YouTube to enable playlist management features',
  {
    authCode: z
      .string()
      .optional()
      .describe('Authorization code from OAuth flow (if providing code)'),
    getAuthUrl: z.boolean().default(false).describe('Set to true to get the authorization URL'),
  },
  async ({ authCode, getAuthUrl: shouldGetAuthUrl }) => {
    if (!oauth2Client) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'OAuth not configured',
                message:
                  'Please set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET environment variables.',
                setupInstructions:
                  'Visit https://console.developers.google.com/ to create OAuth credentials.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (shouldGetAuthUrl) {
      const authUrl = getAuthUrl();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                authUrl,
                instructions: [
                  '1. Open the provided URL in your browser',
                  '2. Sign in to your Google account and grant permissions',
                  '3. You will be redirected to http://localhost (page may not load — that is OK)',
                  '4. Copy the "code" parameter value from the URL bar (everything after "code=" and before "&")',
                  '5. Call this tool again with that value as the authCode parameter',
                ],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (!authCode) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Missing authorization code',
                message:
                  'Please provide either getAuthUrl=true to get the auth URL, or authCode with your authorization code.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const { tokens } = await oauth2Client.getToken(authCode);
      oauth2Client.setCredentials(tokens);

      // Persist tokens to disk so auth survives restarts
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

      // Auto-refresh access token using refresh token when it expires
      oauth2Client.on('tokens', (refreshed) => {
        const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...refreshed }, null, 2));
      });

      // Create authenticated YouTube client
      authenticatedYoutube = google.youtube({
        version: 'v3',
        auth: oauth2Client,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message:
                  'Successfully authenticated with YouTube! You can now create and manage playlists.',
                expires: tokens.expiry_date
                  ? new Date(tokens.expiry_date).toISOString()
                  : 'Unknown',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication failed',
                message: error instanceof Error ? error.message : 'Unknown error occurred',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// Tool: Search for music videos
server.tool(
  'search_music_videos',
  'Search YouTube for music videos',
  {
    query: z.string().describe('Search query for music videos'),
    maxResults: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return'),
    order: z
      .enum(['relevance', 'date', 'rating', 'viewCount', 'title'])
      .default('relevance')
      .describe('Order to sort results'),
  },
  async ({ query, maxResults, order }) => {
    try {
      const response = await youtube.search.list({
        part: ['snippet'],
        q: `${query} music video`,
        type: ['video'],
        videoCategoryId: '10', // Music category
        maxResults,
        order,
        videoEmbeddable: 'true',
        safeSearch: 'none',
      });

      const videos =
        response.data.items?.map((item) => ({
          videoId: item.id?.videoId,
          title: item.snippet?.title,
          description: item.snippet?.description,
          channelTitle: item.snippet?.channelTitle,
          publishedAt: item.snippet?.publishedAt,
          thumbnails: item.snippet?.thumbnails,
          url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
        })) || [];

      return {
        content: [
          {
            type: 'text',
            text: `Found ${videos.length} music videos for "${query}":\n\n${videos
              .map(
                (video, index) =>
                  `${index + 1}. **${video.title}** by ${video.channelTitle}\n   Video ID: ${
                    video.videoId
                  }\n   URL: ${video.url}\n   Published: ${video.publishedAt}`
              )
              .join('\n\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching for videos: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Create a new playlist
server.tool(
  'create_playlist',
  'Create a new YouTube playlist',
  {
    title: z.string().describe('Title for the new playlist'),
    description: z.string().optional().describe('Description for the playlist'),
    privacy: z
      .enum(['private', 'public', 'unlisted'])
      .default('private')
      .describe('Privacy setting for the playlist'),
  },
  async ({ title, description, privacy }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message: 'To create playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
                details: {
                  title,
                  description: description || 'No description',
                  privacy,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const response = await authenticatedYoutube!.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title,
            description: description || '',
          },
          status: {
            privacyStatus: privacy,
          },
        },
      });

      const playlist = response.data;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: 'Playlist created successfully!',
                playlist: {
                  id: playlist.id,
                  title: playlist.snippet?.title,
                  description: playlist.snippet?.description,
                  privacy: playlist.status?.privacyStatus,
                  url: `https://www.youtube.com/playlist?list=${playlist.id}`,
                  publishedAt: playlist.snippet?.publishedAt,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to create playlist',
                message: error instanceof Error ? error.message : String(error),
                details: { title, description, privacy },
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Edit playlist information
server.tool(
  'edit_playlist',
  'Edit playlist information such as title, description, and privacy status',
  {
    playlistId: z.string().describe('ID of the playlist to edit'),
    title: z.string().optional().describe('New title for the playlist'),
    description: z.string().optional().describe('New description for the playlist'),
    privacy: z
      .enum(['private', 'public', 'unlisted'])
      .optional()
      .describe('New privacy setting for the playlist'),
  },
  async ({ playlistId, title, description, privacy }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message: 'To edit playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
                details: { playlistId, title, description, privacy },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Check if at least one field to update is provided
    if (!title && !description && !privacy) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'No updates provided',
                message:
                  'Please provide at least one field to update: title, description, or privacy.',
                details: { playlistId },
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    try {
      // First, get the current playlist information
      const currentPlaylist = await authenticatedYoutube!.playlists.list({
        part: ['snippet', 'status'],
        id: [playlistId],
      });

      if (!currentPlaylist.data.items || currentPlaylist.data.items.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'Playlist not found',
                  message: 'The specified playlist was not found or you do not have access to it.',
                  playlistId,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const playlist = currentPlaylist.data.items[0];

      // Prepare the update request body
      const updateBody: any = {
        id: playlistId,
        snippet: {
          title: title || playlist.snippet?.title,
          description: description !== undefined ? description : playlist.snippet?.description,
        },
      };

      // Only include status if privacy is being updated
      if (privacy) {
        updateBody.status = {
          privacyStatus: privacy,
        };
      }

      // Determine which parts to update
      const parts = ['snippet'];
      if (privacy) {
        parts.push('status');
      }

      const response = await authenticatedYoutube!.playlists.update({
        part: parts,
        requestBody: updateBody,
      });

      const updatedPlaylist = response.data;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: 'Playlist updated successfully!',
                updates: {
                  ...(title && { title: `"${playlist.snippet?.title}" → "${title}"` }),
                  ...(description !== undefined && {
                    description: `"${playlist.snippet?.description || ''}" → "${description}"`,
                  }),
                  ...(privacy && {
                    privacy: `"${playlist.status?.privacyStatus}" → "${privacy}"`,
                  }),
                },
                playlist: {
                  id: updatedPlaylist.id,
                  title: updatedPlaylist.snippet?.title,
                  description: updatedPlaylist.snippet?.description,
                  privacy: updatedPlaylist.status?.privacyStatus,
                  url: `https://www.youtube.com/playlist?list=${updatedPlaylist.id}`,
                  publishedAt: updatedPlaylist.snippet?.publishedAt,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to edit playlist',
                message: error instanceof Error ? error.message : String(error),
                details: { playlistId, title, description, privacy },
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Add video to playlist
server.tool(
  'add_to_playlist',
  'Add a video to a YouTube playlist',
  {
    playlistId: z.string().describe('ID of the playlist to add video to'),
    videoId: z.string().describe('YouTube video ID to add to playlist'),
  },
  async ({ playlistId, videoId }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message: 'To add videos to playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
                details: { playlistId, videoId },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const response = await authenticatedYoutube!.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: 'youtube#video',
              videoId,
            },
          },
        },
      });

      const item = response.data;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: 'Video added to playlist successfully!',
                playlistItem: {
                  id: item.id,
                  playlistId: item.snippet?.playlistId,
                  videoId: item.snippet?.resourceId?.videoId,
                  title: item.snippet?.title,
                  publishedAt: item.snippet?.publishedAt,
                  position: item.snippet?.position,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to add video to playlist',
                message: error instanceof Error ? error.message : String(error),
                details: { playlistId, videoId },
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: List user's playlists
server.tool(
  'list_playlists',
  'List YouTube playlists (requires OAuth for user playlists)',
  {
    maxResults: z
      .number()
      .min(1)
      .max(50)
      .default(25)
      .describe('Maximum number of playlists to return'),
    mine: z
      .boolean()
      .default(true)
      .describe("List authenticated user's playlists (requires OAuth)"),
  },
  async ({ maxResults, mine }) => {
    if (mine && !isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message: 'To list your playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
                alternative:
                  'Set mine=false to search for public playlists (this feature would need additional implementation)',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const response = await authenticatedYoutube!.playlists.list({
        part: ['snippet', 'contentDetails', 'status'],
        mine: mine,
        maxResults: maxResults,
      });

      const playlists =
        response.data.items?.map((playlist) => ({
          id: playlist.id,
          title: playlist.snippet?.title,
          description: playlist.snippet?.description,
          publishedAt: playlist.snippet?.publishedAt,
          itemCount: playlist.contentDetails?.itemCount,
          privacy: playlist.status?.privacyStatus,
          url: `https://www.youtube.com/playlist?list=${playlist.id}`,
        })) || [];

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: `Found ${playlists.length} playlist(s)`,
                playlists,
                totalResults: response.data.pageInfo?.totalResults,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to list playlists',
                message: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Get playlist items
server.tool(
  'get_playlist_items',
  'Get videos from a YouTube playlist (use authenticated client for private playlists)',
  {
    playlistId: z.string().describe('ID of the playlist to get items from'),
    maxResults: z.number().min(1).max(50).default(50).describe('Maximum number of items to return'),
  },
  async ({ playlistId, maxResults }) => {
    try {
      const client = isOAuthConfigured() ? authenticatedYoutube! : youtube;
      const response = await client.playlistItems.list({
        part: ['snippet', 'contentDetails'],
        playlistId,
        maxResults,
      });

      const items =
        response.data.items?.map((item) => ({
          playlistItemId: item.id,
          videoId: item.contentDetails?.videoId,
          title: item.snippet?.title,
          channelTitle: item.snippet?.videoOwnerChannelTitle,
          publishedAt: item.snippet?.publishedAt,
          url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`,
          position: item.snippet?.position,
        })) || [];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                playlistId,
                itemCount: items.length,
                totalResults: response.data.pageInfo?.totalResults,
                items,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting playlist items: ${
              error instanceof Error ? error.message : String(error)
            }. Make sure the playlist ID is correct and the playlist is accessible.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Get video details
server.tool(
  'get_video_details',
  'Get detailed information about a YouTube video',
  {
    videoId: z.string().describe('YouTube video ID'),
  },
  async ({ videoId }) => {
    try {
      const response = await youtube.videos.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        id: [videoId],
      });

      const video = response.data.items?.[0];
      if (!video) {
        return {
          content: [
            {
              type: 'text',
              text: `No video found with ID: ${videoId}`,
            },
          ],
          isError: true,
        };
      }

      const snippet = video.snippet;
      const statistics = video.statistics;
      const contentDetails = video.contentDetails;

      return {
        content: [
          {
            type: 'text',
            text: `**${snippet?.title}**
Channel: ${snippet?.channelTitle}
Published: ${snippet?.publishedAt}
Duration: ${contentDetails?.duration}
Views: ${statistics?.viewCount?.toLocaleString()}
Likes: ${statistics?.likeCount?.toLocaleString()}
Comments: ${statistics?.commentCount?.toLocaleString()}

Description:
${snippet?.description}

URL: https://www.youtube.com/watch?v=${videoId}
Category: ${snippet?.categoryId}
Tags: ${snippet?.tags?.join(', ') || 'None'}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting video details: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Check authentication status
server.tool(
  'get_auth_status',
  'Check if YouTube OAuth authentication is configured and active',
  {},
  async () => {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              oauthConfigured: oauth2Client !== null,
              authenticated: isOAuthConfigured(),
              clientConfigured: !!(CLIENT_ID && CLIENT_SECRET),
              message: isOAuthConfigured()
                ? 'OAuth is configured and authenticated. You can create and manage playlists.'
                : oauth2Client
                ? 'OAuth is configured but not authenticated. Use authenticate_youtube tool to authenticate.'
                : 'OAuth not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET environment variables.',
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Remove video from playlist
server.tool(
  'remove_from_playlist',
  'Remove a video from a YouTube playlist',
  {
    playlistItemId: z.string().describe('ID of the playlist item to remove (not the video ID)'),
  },
  async ({ playlistItemId }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message:
                  'To remove videos from playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
                note: 'You need the playlist item ID, not the video ID. Get this from get_playlist_items tool.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      await authenticatedYoutube!.playlistItems.delete({
        id: playlistItemId,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: 'Video removed from playlist successfully!',
                playlistItemId,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to remove video from playlist',
                message: error instanceof Error ? error.message : String(error),
                playlistItemId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Delete a playlist
server.tool(
  'delete_playlist',
  'Permanently delete a YouTube playlist (requires OAuth)',
  {
    playlistId: z.string().describe('ID of the playlist to delete'),
  },
  async ({ playlistId }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Authentication required',
                message: 'To delete playlists, you need to authenticate with OAuth first.',
                instruction:
                  'Use the authenticate_youtube tool with getAuthUrl=true to start the authentication process.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      await authenticatedYoutube!.playlists.delete({
        id: playlistId,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: 'Playlist deleted successfully.',
                playlistId,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'Failed to delete playlist',
                message: error instanceof Error ? error.message : String(error),
                playlistId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: List all channels for the authenticated user
server.tool(
  'list_my_channels',
  'List all YouTube channels associated with the authenticated Google account',
  {},
  async () => {
    if (!isOAuthConfigured()) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required' }) }],
      };
    }
    try {
      const response = await authenticatedYoutube!.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        mine: true,
        maxResults: 50,
      });
      const channels = response.data.items?.map((c) => ({
        id: c.id,
        title: c.snippet?.title,
        customUrl: c.snippet?.customUrl,
        description: c.snippet?.description,
        subscriberCount: c.statistics?.subscriberCount,
        videoCount: c.statistics?.videoCount,
      })) || [];
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channels }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
        isError: true,
      };
    }
  }
);

// Tool: List playlists for a specific channel
server.tool(
  'list_channel_playlists',
  'List playlists for a specific YouTube channel by channel ID',
  {
    channelId: z.string().describe('The YouTube channel ID'),
    maxResults: z.number().min(1).max(50).default(50).describe('Maximum number of playlists to return'),
  },
  async ({ channelId, maxResults }) => {
    if (!isOAuthConfigured()) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication required' }) }],
      };
    }
    try {
      const response = await authenticatedYoutube!.playlists.list({
        part: ['snippet', 'contentDetails', 'status'],
        channelId,
        maxResults,
      });
      const playlists = response.data.items?.map((p) => ({
        id: p.id,
        title: p.snippet?.title,
        description: p.snippet?.description,
        itemCount: p.contentDetails?.itemCount,
        privacy: p.status?.privacyStatus,
        url: `https://www.youtube.com/playlist?list=${p.id}`,
      })) || [];
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, totalResults: response.data.pageInfo?.totalResults, playlists }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
        isError: true,
      };
    }
  }
);

// Main function to start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('YouTube Playlist Generator MCP Server is running...');
}

// Handle process termination gracefully
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
