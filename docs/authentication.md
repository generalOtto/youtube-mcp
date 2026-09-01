# Authentication

How the server authenticates with the YouTube Data API, and how to (re-)authenticate
projects when tokens are missing or revoked.

## How it works

The YouTube Data API v3 allows **10,000 quota units per day per Google Cloud project**.
Playlist reorganization at scale burns through that quickly, so this server supports
holding OAuth credentials for **multiple Google Cloud projects** and rotating between
them, multiplying your effective daily quota.

Everything lives under `~/.youtube-mcp/`:

| File | Purpose |
|---|---|
| `credentials.json` | Client IDs and secrets for each configured project |
| `tokens-{n}.json` | OAuth tokens for project *n* — persisted, so you authenticate once |
| `state.json` | Currently active project index |

If `credentials.json` is absent, the server falls back to single-project mode using the
`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_API_KEY` environment variables.

## Check status first

Ask your MCP client (e.g. Claude Code):

> "check YouTube project status"

This calls `get_project_status` and shows which projects have valid tokens and which need
re-authentication.

## Re-authenticating a project

1. **Get the auth URL** — ask: *"give me the YouTube auth URL for project 0"* (or 1, 2, …).
2. **Sign in** — open the URL, sign in with the Google account that owns the channel, and
   grant permissions.
3. **Capture the code** — you'll be redirected to `http://localhost` (the page won't load;
   that's expected). Copy the full redirect URL, or just the `code=` value, from the
   address bar.
4. **Paste it back** — paste the redirect URL into your MCP client. The token is saved to
   `~/.youtube-mcp/tokens-{index}.json`.

> ⚠️ Auth codes expire in about 60 seconds — complete steps 2–4 quickly.

## Adding a new Google Cloud project

To raise your quota ceiling, add another project:

1. Go to `console.cloud.google.com` → **New Project**.
2. Enable the **YouTube Data API v3**.
3. Create **OAuth 2.0 credentials** (application type *Desktop app*, redirect URI
   `http://localhost`).
4. Add your Google account as a test user under **OAuth consent screen → Test users**
   (required while the consent screen is in Testing mode).
5. Add the new client ID and secret to `~/.youtube-mcp/credentials.json`.
6. Authenticate the new project index using the flow above.

> Note on brand accounts: a brand-style channel that is the account's **primary** YouTube
> channel authenticates via standard OAuth — no brand-account token handling needed.
