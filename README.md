# youtube-mcp

An MCP (Model Context Protocol) server for YouTube playlist management. Lets you create, delete, and reorganize YouTube playlists directly through Claude.

## Features

- List all playlists on your YouTube account
- Create and delete playlists
- Add and remove videos from playlists
- Move videos between playlists
- List all channels on an account
- Search for music videos
- Get detailed video metadata

## Setup

### Prerequisites

- Node.js 18 or later
- A Google Cloud project with the YouTube Data API v3 enabled
- A YouTube API key (for read-only operations)
- Google OAuth 2.0 credentials — Client ID and Client Secret — for write operations (create/delete playlists, manage videos)

### Installation

```bash
git clone https://github.com/MetalOath/youtube-mcp.git
cd youtube-mcp
npm install
npm run build
```

### Configuration in Claude Code

Add the server to your `.claude.json` configuration:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/absolute/path/to/youtube-mcp/build/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key_here",
        "YOUTUBE_CLIENT_ID": "your_client_id_here",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret_here"
      }
    }
  }
}
```

Replace the path and credential values with your own. Restart Claude Code after saving the config.

## Authentication

This server uses two levels of access:

**API key** — required for all read-only operations (searching videos, listing public playlists, etc.). Set via `YOUTUBE_API_KEY`.

**OAuth 2.0** — required for write operations (creating/deleting playlists, managing playlist contents). Set via `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.

To set up OAuth credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and open your project.
2. Enable the YouTube Data API v3.
3. Under Credentials, create an OAuth 2.0 Client ID with application type "Desktop App".
4. Copy the Client ID and Client Secret into your config.

To complete the OAuth flow at runtime:

1. Call `authenticate_youtube` with `getAuthUrl: true` to get an authorization URL.
2. Open the URL in your browser and grant access to your Google account.
3. Copy the authorization code from the redirect URL.
4. Call `authenticate_youtube` again with the `authCode` to complete authentication.

OAuth credentials are held in memory for the duration of the session. You will need to re-authenticate each time the server restarts.

## Available Tools

| Tool | Description |
|---|---|
| `authenticate_youtube` | Start or complete the OAuth flow to enable write access |
| `get_auth_status` | Check whether OAuth authentication is currently active |
| `list_my_channels` | List all YouTube channels associated with the authenticated account |
| `list_playlists` | List playlists for a given channel ID |
| `list_channel_playlists` | List playlists for the authenticated user's own channel |
| `create_playlist` | Create a new playlist with a title, description, and privacy setting |
| `edit_playlist` | Update the title, description, or privacy of an existing playlist |
| `delete_playlist` | Delete a playlist by ID |
| `get_playlist_items` | Retrieve all videos in a playlist |
| `add_to_playlist` | Add a video to a playlist |
| `remove_from_playlist` | Remove a video from a playlist by playlist item ID |
| `search_music_videos` | Search YouTube for music videos by query string |
| `get_video_details` | Get metadata for a specific video by ID |

## License

MIT
