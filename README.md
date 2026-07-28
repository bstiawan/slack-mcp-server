# slack-mcp-server
## Disclaimer
This project includes [code](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack) originally developed by Anthropic and released under the MIT License. Substantial modifications and new functionality have been added by For Good AI Inc. (dba Zencoder Inc.), and are licensed under the Apache License, Version 2.0.

## Overview
A Model Context Protocol (MCP) server for interacting with Slack workspaces. This server provides tools to list channels, post messages, reply to threads, add reactions, get channel history, inspect Slack file attachments, manage users, and inspect Slack metadata with bot and user tokens.

## Available Tools

1. **slack_list_channels**
   - List public or pre-defined channels in the workspace
   - Optional inputs:
     - `limit` (number, default: 100, max: 200): Maximum number of channels to return
     - `cursor` (string): Pagination cursor for next page
   - Returns: List of channels with their IDs and information

2. **slack_post_message**
   - Low-level bot-only post to a Slack channel
   - Prefer `slack_send_message` for identity-aware user-authored sends
   - Required inputs:
     - `channel_id` (string): The ID of the channel to post to
     - `text` (string): The message text to post
   - Returns: Message posting confirmation and timestamp

3. **slack_reply_to_thread**
   - Low-level bot-only reply to a specific message thread
   - Prefer `slack_send_message` with `thread_ts` for identity-aware user-authored replies
   - Required inputs:
     - `channel_id` (string): The channel containing the thread
     - `thread_ts` (string): Timestamp of the parent message
     - `text` (string): The reply text
   - Returns: Reply confirmation and timestamp

4. **slack_add_reaction**
   - Add an emoji reaction to a message
   - Required inputs:
     - `channel_id` (string): The channel containing the message
     - `timestamp` (string): Message timestamp to react to
     - `reaction` (string): Emoji name without colons
   - Returns: Reaction confirmation

5. **slack_get_channel_history**
   - Get recent messages from a channel
   - Required inputs:
     - `channel_id` (string): The channel ID
   - Optional inputs:
     - `limit` (number, default: 10): Number of messages to retrieve
     - `include_files` (boolean, default: false): Fetch Slack file metadata for file messages
     - `include_file_content` (boolean, default: false): Download supported image/text file content
   - Returns: List of messages with their content and metadata
   - Messages with files, attachments, or image blocks include `attachment_summary` by default so agents know when to call `slack_read_file`

6. **slack_get_thread_replies**
   - Get all replies in a message thread
   - Required inputs:
     - `channel_id` (string): The channel containing the thread
     - `thread_ts` (string): Timestamp of the parent message
   - Returns: List of replies with their content and metadata
   - Messages with files, attachments, or image blocks include `attachment_summary` by default

7. **slack_get_users**
   - Get list of workspace users with basic profile information
   - Optional inputs:
     - `cursor` (string): Pagination cursor for next page
     - `limit` (number, default: 100, max: 200): Maximum users to return
   - Returns: List of users with their basic profiles

8. **slack_get_user_profile**
   - Get detailed profile information for a specific user
   - Required inputs:
     - `user_id` (string): The user's ID
   - Returns: Detailed user profile information

### Hybrid Inspection Tools

These tools use optional non-bot tokens when configured:

9. **slack_get_workspace_access_report**
   - Show which Slack token roles are configured and what each can inspect
   - Does not return token values

10. **slack_list_conversations**
   - List conversations using the best configured read token
   - Uses `SLACK_USER_TOKEN` when configured, otherwise `SLACK_BOT_TOKEN`
   - Optional inputs: `limit`, `cursor`, `types`, `exclude_archived`, `token_role`

11. **slack_get_conversation_info**
   - Get conversation metadata
   - Uses `SLACK_USER_TOKEN` when configured, otherwise `SLACK_BOT_TOKEN`
   - Optional inputs: `include_locale`, `include_num_members`, `token_role`

12. **slack_get_conversation_members**
   - List conversation members
   - Uses `SLACK_USER_TOKEN` when configured, otherwise `SLACK_BOT_TOKEN`
   - Optional inputs: `limit`, `cursor`, `token_role`
   - Intended for membership inspection, not message content access

The existing **slack_get_channel_history** tool also supports `cursor`, `oldest`, `latest`, `inclusive`, `token_role`, `include_files`, `include_file_content`, `max_file_bytes`, and `max_files`. By default it uses `SLACK_USER_TOKEN` when configured, otherwise `SLACK_BOT_TOKEN`.

### Attachment and File Tools

Read tools always add a compact `attachment_summary` to messages containing Slack `files`, `attachments`, or image blocks. File bytes are never downloaded by default.

13. **slack_get_file_info**
   - Get sanitized Slack file metadata with `file_id` and optional `token_role`
   - Uses Slack `files.info`
   - Does not return token values or private Slack download URLs

14. **slack_read_file**
   - Read supported Slack-hosted file content with `file_id`, optional `token_role`, and optional `max_bytes`
   - Defaults to user token, then bot token fallback
   - Default and maximum download cap: 10 MB
   - Images return MCP `image` content
   - Text-like files return embedded MCP text resources
   - Unsupported files such as PDFs, DOCX, spreadsheets, video, and audio return metadata only with `access_limitation`

### Skill-Compatible Goal Tools

These are the preferred tools for agents using the bundled Slack skills. They choose bot or user access internally and include compact routing metadata in the response.

15. **slack_read_user_profile**
   - Read the current identity profile by default, or a specific `user_id`

16. **slack_search_channels**
   - Resolve channel names and IDs through the best available metadata token

17. **slack_read_channel**
   - Read channel messages with `channel_id`, `limit`, `oldest`, `latest`, and `cursor`
   - Defaults to `SLACK_USER_TOKEN`, then falls back safely to `SLACK_BOT_TOKEN`
   - Supports `include_files`, `include_file_content`, `max_file_bytes`, and `max_files`
   - Messages with files, attachments, or image blocks include `attachment_summary` by default

18. **slack_read_thread**
   - Read thread replies with `channel_id`, `thread_ts`, `limit`, and `cursor`
   - Defaults to `SLACK_USER_TOKEN`, then falls back safely to `SLACK_BOT_TOKEN`
   - Supports the same attachment/file options as `slack_read_channel`

19. **slack_search_users**
   - Search users by ID, name, display name, real name, or email where available

20. **slack_search_public_and_private**
   - Search Slack messages with `search.messages` where token scopes allow
   - Accepts `channel_types` for skill compatibility, but actual coverage follows Slack search and token access

21. **slack_search_conversations**
   - Search conversations by name by filtering one bounded `conversations.list` page
   - User token covers public/private channels; bot token can also cover IM/MPIM where bot scopes allow

22. **slack_get_channel_history_by_name**
   - Resolve a channel by name, then read message history with intent-aware routing
   - Supports the same attachment/file options as `slack_read_channel`

23. **slack_send_message**
   - Send messages with `target`, `text`, `thread_ts`, `message_intent`, and `allow_identity_fallback`
   - `outbound_message` prefers user identity
   - `notification`, `reminder`, and `automation_update` prefer bot identity
   - For Bayu-on-behalf or other human-to-human reminders, use `outbound_message`, not `reminder`
   - Disable identity fallback when the sender identity matters

24. **slack_edit_message** and **slack_delete_message**
   - Edit or delete messages with identity-aware routing
   - Slack only permits editing/deleting messages owned or deletable by the selected identity

25. **slack_schedule_message**
   - Schedule messages with the same identity-aware routing as `slack_send_message`
   - For Bayu-on-behalf or other human-to-human reminders, use `outbound_message`, not `reminder`

26. **slack_send_message_draft** and **slack_create_canvas**
   - Return structured `unsupported_action` responses in this server because Slack Web API draft/canvas creation is not implemented here

Skill-facing responses include a `routing` object with `selected_token_role`, `fallback_attempts`, `routing_reason`, and optional `access_limitation`. Token values are never returned.

## Slack Bot Setup

To use this MCP server, you need to create a Slack app and configure it with the necessary permissions:

### 1. Create a Slack App
- Visit the [Slack Apps page](https://api.slack.com/apps)
- Click "Create New App"
- Choose "From scratch"
- Name your app and select your workspace

### 2. Configure Bot Token Scopes
Navigate to "OAuth & Permissions" and add these scopes:
- `channels:history` - View messages and other content in public channels
- `channels:read` - View basic channel information
- `chat:write` - Send messages as the app
- `reactions:write` - Add emoji reactions to messages
- `users:read` - View users and their basic information
- `users.profile:read` - View detailed profiles about users
- `files:read` - View and download files shared in conversations the app can access

Optional hybrid inspection scopes:
- User token (`SLACK_USER_TOKEN`, `xoxp-`): `channels:history`, `channels:read`; add `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, and `files:read` only for conversation and file types the user token is allowed to access.

The current tested user token scope set includes `chat:write`, `channels:history`, `channels:read`, `groups:read`, `groups:history`, `im:history`, `mpim:history`, `search:read`, `search:read.im`, `search:read.mpim`, `search:read.public`, `search:read.users`, `users.profile:read`, and `identify`. The current bot scope set includes channel/group/IM/MPIM read and history scopes, `chat:write`, `chat:write.public`, reactions, pins, files, search read scopes, and `users:read`.

### 3. Install App to Workspace
- Click "Install to Workspace" and authorize the app
- Save the "Bot User OAuth Token" that starts with `xoxb-`

### 4. Get Your Team ID
Get your Team ID (starts with a `T`) by following [this guidance](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID#find-your-workspace-or-org-id)

### 5. Add Bot to Channels (Optional)
For the bot to access private channels or to post messages, you may need to invite it to specific channels using `/invite @your-bot-name`

### Slack API Access Limits

- Slack does not allow arbitrary private-channel or DM history access through these tools.
- `SLACK_BOT_TOKEN` is member-limited: it can read private channels only after the bot is invited, and public/private visibility still follows Slack app permissions.
- `SLACK_USER_TOKEN` broadens public-channel history inspection for channels the user token can read; it does not grant arbitrary private-channel or DM access.

## Features

- **Multiple Transport Support**: Supports both stdio and Streamable HTTP transports
- **Modern MCP SDK**: Uses MCP SDK v1.15.1 with modern APIs
- **Comprehensive Slack Integration**: Full set of Slack operations including:
  - List channels (with predefined channel support)
  - Post messages
  - Reply to threads
  - Add reactions
  - Get channel history
  - Get thread replies
  - List users
  - Get user profiles
  - Inspect public-channel history with an optional user token
  - Identify messages with Slack files, attachments, or image blocks
  - Read Slack-hosted images and text-like files through MCP-native content
  - Skill-compatible read, search, and send tools with intent-aware token routing

## Bundled Skills

This repository includes installable Codex skills under `skills/`:

- `skills/slack-mcp` - use this MCP server when Slack may contain useful team context, including reads, searches, threads, linked messages, attachments/files, writes, cleanup, and Slack-native `mrkdwn` formatting.

## Installation

### Local Development
```bash
npm install
npm run build
```

### Global Installation (NPM)
```bash
npm install -g @zencoderai/slack-mcp-server
```

### Docker Installation
```bash
# Build the Docker image locally
docker build -t slack-mcp-server .

# Or pull from Docker Hub
docker pull zencoderai/slack-mcp:latest

# Or pull a specific version
docker pull zencoderai/slack-mcp:1.0.0
```

## Configuration

Set the following environment variables:

```bash
export SLACK_BOT_TOKEN="xoxb-your-bot-token"
export SLACK_USER_TOKEN="xoxp-your-user-token"  # Optional: public-channel inspection
export SLACK_TEAM_ID="your-team-id"
export SLACK_CHANNEL_IDS="channel1,channel2,channel3"  # Optional: predefined channels
export AUTH_TOKEN="your-auth-token"  # Optional: Bearer token for HTTP authorization (Streamable HTTP transport only)
```

## Usage

### Command Line Options

```bash
slack-mcp [options]

Options:
  --transport <type>     Transport type: 'stdio' or 'http' (default: stdio)
  --port <number>        Port for HTTP server when using Streamable HTTP transport (default: 3000)
  --token <token>        Bearer token for HTTP authorization (optional, can also use AUTH_TOKEN env var)
  --help, -h             Show this help message
```

### Local Usage Examples

#### Using the slack-mcp command (after global installation)
```bash
# Use stdio transport (default)
slack-mcp

# Use stdio transport explicitly
slack-mcp --transport stdio

# Use Streamable HTTP transport on default port 3000
slack-mcp --transport http

# Use Streamable HTTP transport on custom port
slack-mcp --transport http --port 8080

# Use Streamable HTTP transport with custom auth token
slack-mcp --transport http --token mytoken

# Use Streamable HTTP transport with auth token from environment variable
AUTH_TOKEN=mytoken slack-mcp --transport http
```

#### Using node directly (for development)
```bash
# Use stdio transport (default)
node dist/index.js

# Use stdio transport explicitly
node dist/index.js --transport stdio

# Use Streamable HTTP transport on default port 3000
node dist/index.js --transport http

# Use Streamable HTTP transport on custom port
node dist/index.js --transport http --port 8080

# Use Streamable HTTP transport with custom auth token
node dist/index.js --transport http --token mytoken

# Use Streamable HTTP transport with auth token from environment variable
AUTH_TOKEN=mytoken node dist/index.js --transport http
```

### Docker Usage Examples

#### Using Docker directly
```bash
# Run with stdio transport (default)
docker run --rm \
  -e SLACK_BOT_TOKEN="xoxb-your-bot-token" \
  -e SLACK_USER_TOKEN="xoxp-your-user-token" \
  -e SLACK_TEAM_ID="your-team-id" \
  zencoderai/slack-mcp:latest

# Run with HTTP transport on port 3000
docker run --rm -p 3000:3000 \
  -e SLACK_BOT_TOKEN="xoxb-your-bot-token" \
  -e SLACK_USER_TOKEN="xoxp-your-user-token" \
  -e SLACK_TEAM_ID="your-team-id" \
  zencoderai/slack-mcp:latest --transport http

# Run with HTTP transport on custom port
docker run --rm -p 8080:8080 \
  -e SLACK_BOT_TOKEN="xoxb-your-bot-token" \
  -e SLACK_USER_TOKEN="xoxp-your-user-token" \
  -e SLACK_TEAM_ID="your-team-id" \
  zencoderai/slack-mcp:latest --transport http --port 8080

# Run with custom auth token
docker run --rm -p 3000:3000 \
  -e SLACK_BOT_TOKEN="xoxb-your-bot-token" \
  -e SLACK_USER_TOKEN="xoxp-your-user-token" \
  -e SLACK_TEAM_ID="your-team-id" \
  -e AUTH_TOKEN="mytoken" \
  zencoderai/slack-mcp:latest --transport http
```

#### Using Docker Compose
Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  slack-mcp:
    # Use published image:
    image: zencoderai/slack-mcp:latest
    # Or build locally:
    # build: .
    environment:
      - SLACK_BOT_TOKEN=xoxb-your-bot-token
      - SLACK_USER_TOKEN=xoxp-your-user-token  # Optional
      - SLACK_TEAM_ID=your-team-id
      - SLACK_CHANNEL_IDS=channel1,channel2,channel3  # Optional
      - AUTH_TOKEN=your-auth-token  # Optional for HTTP transport
    ports:
      - "3000:3000"  # Only needed for HTTP transport
    command: ["--transport", "http"]  # Optional: specify transport type
    restart: unless-stopped
```

Then run:
```bash
# Start the service
docker compose up -d

# View logs
docker compose logs -f slack-mcp

# Stop the service
docker compose down
```

## Transport Types

### Stdio Transport
- **Use case**: Command-line tools and direct integrations
- **Communication**: Standard input/output streams
- **Default**: Yes

### Streamable HTTP Transport
- **Use case**: Remote servers and web-based integrations
- **Communication**: HTTP POST requests with optional Server-Sent Events streams
- **Features**: 
  - Session management
  - Bidirectional communication
  - Resumable connections
  - RESTful API endpoints
  - Bearer token authentication

## Authentication (Streamable HTTP Transport Only)

When using Streamable HTTP transport, the server supports Bearer token authentication:

1. **Command Line**: Use `--token <token>` to specify a custom token
2. **Environment Variable**: Set `AUTH_TOKEN=<token>` as a fallback
3. **Auto-generated**: If neither is provided, a random token is generated

The command line option takes precedence over the environment variable. Include the token in HTTP requests using the `Authorization: Bearer <token>` header.

## Troubleshooting

If you encounter permission errors, verify that:

1. All required scopes are added to your Slack app
2. The app is properly installed to your workspace
3. The tokens and workspace ID are correctly copied to your configuration
4. The app has been added to the channels it needs to access

## Development

### Build
```bash
npm run build
```

### Watch Mode
```bash
npm run watch
```

## API Endpoints (Streamable HTTP Transport)

When using Streamable HTTP transport, the server exposes the following endpoints:

- `POST /mcp` - Client-to-server communication
- `GET /mcp` - Server-to-client notifications (Server-Sent Events streams)
- `DELETE /mcp` - Session termination

## Changes from Previous Version

- **Updated MCP SDK**: Upgraded from v1.0.1 to v1.15.1
- **Modern API**: Migrated from low-level Server class to high-level McpServer class
- **Zod Validation**: Added proper schema validation using Zod
- **Transport Flexibility**: Added support for Streamable HTTP transport
- **Command Line Interface**: Added CLI arguments for transport selection
- **Session Management**: Implemented proper session handling for HTTP transport
- **Better Error Handling**: Improved error handling and logging
