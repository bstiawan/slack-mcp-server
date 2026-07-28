---
name: slack-mcp
description: "Use when working with Slack through this MCP server, or when an agent needs current team context that may exist in Slack: understand user goals, search Slack, read channels or threads, inspect linked messages, inspect images and attachments, draft or send messages, schedule/edit/delete Slack messages, and format outgoing text in Slack mrkdwn."
---

# Slack MCP

Use this skill when a user asks to understand, search, summarize, triage, draft, send, schedule, edit, or clean up Slack content through this MCP server.

Also use it proactively when Slack is a likely source of missing context for another task, even if the user did not explicitly mention Slack.

## When To Use Slack As Context

Slack is often the freshest source for human decisions, handoffs, incident status, customer context, design reviews, deployment notes, screenshots, and unresolved questions.

Use Slack before asking the user for missing context when:

- The task depends on recent team state, decisions, ownership, approvals, blockers, customer/account updates, or "what happened" context.
- The user references a person, team, channel, project, incident, launch, property, partner, customer, ticket, PR, deployment, or message link that may have Slack discussion.
- Local docs, repo files, issues, or memory are stale, ambiguous, or missing the conversation behind a decision.
- The answer would be materially better with a screenshot, uploaded spec, log file, CSV, or image that was likely shared in Slack.
- You need to verify whether a requested write/reply is still appropriate based on the latest thread context.

Do not use Slack just because it is available. Skip Slack when the current repo, provided files, or user message already contain enough evidence. Do not browse unrelated private conversations. For writes, edits, deletes, and broad notifications, require clear user intent and a confirmed target.

## Goal First

Start from the user's outcome, then choose the narrowest Slack reads and writes needed.

- Identify the target: channel, user, DM, message link, thread, file, topic, or timeframe.
- Prefer direct lookup/search over paging broad lists.
- Read current context before writing, replying, editing, deleting, or summarizing.
- Do not claim access to private channels, DMs, files, or history until a tool result confirms access.
- Let skill-facing tools route bot/user token choice internally unless the task is specifically diagnosing access.

## Context Workflow

Use a small evidence loop:

1. Define the information gap: what Slack evidence would change the answer?
2. Search or resolve the most likely target with `slack_search_conversations`, `slack_search_channels`, `slack_search_users`, or `slack_search_public_and_private`.
3. Read the smallest useful window with `slack_read_channel`, `slack_get_channel_history_by_name`, or `slack_read_thread`.
4. Follow thread replies before summarizing a discussion or drafting a response.
5. Inspect attachments only when `attachment_summary` indicates relevant files, images, or text-like uploads.
6. Synthesize from the messages actually read, and state access gaps without guessing.

If search is blocked, fall back to known channel names/IDs and bounded reads. If multiple targets match and choosing one would be risky, ask a short clarification.

## Tool Routing

Use these preferred tools for goal-oriented work:

| Goal | Preferred tools |
| --- | --- |
| Understand available access | `slack_get_workspace_access_report` |
| Find channels/conversations | `slack_search_conversations`, `slack_search_channels` |
| Read a channel by ID | `slack_read_channel` |
| Read a channel by name | `slack_get_channel_history_by_name` |
| Read a thread | `slack_read_thread` |
| Read legacy thread/history paths | `slack_get_thread_replies`, `slack_get_channel_history` |
| Find messages broadly | `slack_search_public_and_private` |
| Find users | `slack_search_users`, `slack_get_users` |
| Read a profile | `slack_read_user_profile`, `slack_get_user_profile` |
| Inspect file metadata | `slack_get_file_info` |
| Read image/text file content | `slack_read_file` |
| Send a message | `slack_send_message` |
| Schedule a message | `slack_schedule_message` |
| Edit/delete cleanup | `slack_edit_message`, `slack_delete_message` |
| Existing low-level operations | `slack_post_message`, `slack_reply_to_thread`, `slack_add_reaction`, `slack_list_conversations`, `slack_get_conversation_info`, `slack_get_conversation_members` |

Use `token_role` only when the user asks for explicit bot/user behavior or when debugging access. Otherwise, let the MCP router choose.
Do not use low-level `slack_post_message` or `slack_reply_to_thread` for user-authored sends; they are bot-only paths. Use `slack_send_message` with `thread_ts` for identity-aware replies.

## Real-World Playbooks

| Situation | Efficient approach |
| --- | --- |
| Need latest project status | Search for project/channel terms, read recent channel messages, then open threads for decisions or blockers. |
| Need decision rationale | Search decision keywords plus project/person names, read the parent thread, and inspect linked files if referenced. |
| Need to understand a linked Slack message | Parse channel ID and timestamp from the link, read the parent thread, then read nearby channel context only if needed. |
| Need context about a person | Resolve the user/profile, then search messages only when the task requires work context rather than identity. |
| Need to understand a screenshot/spec/log shared in Slack | Read the message first, check `attachment_summary`, then call `slack_read_file` for only the relevant image or text file. |
| Need to draft a reply | Read the current thread, identify the ask and latest state, draft concise Slack `mrkdwn`, and do not send unless requested. |
| Need to send or schedule | Resolve target, read current context if conversation-dependent, use `message_intent`, and avoid silent identity fallback. For human-to-human reminders, use `outbound_message`, not `reminder`. |
| Need cleanup after testing | Use `slack_edit_message` or `slack_delete_message` only with confirmed `channel_id` and `ts`. |

## Reading Context Efficiently

For a channel question:

1. Resolve the channel with `slack_search_conversations` or `slack_search_channels`.
2. Read a bounded window with `slack_read_channel` using `limit`, `oldest`, `latest`, or `cursor`.
3. If a message has replies or the user asks about a discussion, read the thread with `slack_read_thread`.
4. If messages contain files, inspect only the files needed for the user's goal.

For a Slack message link:

- Extract the channel ID from `/archives/C.../`.
- Convert `/p1234567890123456` to timestamp `1234567890.123456`.
- Read the nearby channel context if needed, then call `slack_read_thread` using that timestamp as `thread_ts`.
- If the link is already a threaded reply, read the parent thread and evaluate the linked reply in context.

For broad search:

- Start with `slack_search_public_and_private` when the user asks for a topic across Slack.
- If search is blocked or too broad, resolve likely channels first and use bounded channel reads.
- Avoid paging huge conversation lists when a query-based channel search can answer the lookup.

## Attachments, Images, And Files

Message read tools annotate files and attachment-like content by default. Treat `attachment_summary` as a prompt to decide whether file content is necessary.

- If `attachment_summary.has_files` is true, mention that files are present when reporting context.
- Use `slack_get_file_info` for metadata only.
- Use `slack_read_file` when the file content is needed to answer the user.
- Use `include_files: true` on read tools to enrich message file metadata.
- Use `include_file_content: true` only when the user goal requires inspecting supported image or text-like content.
- Keep `max_file_bytes` bounded; default file reads are intentionally opt-in.

Supported v1 content inspection is image content and text-like files. Unsupported file types should be reported as metadata-only instead of guessed.

## Writes And Identity

Choose write intent from the user's goal:

- `outbound_message`: a message sent on behalf of the user.
- `notification`, `reminder`, `automation_update`: bot-safe operational messages.

In Bayu's workspace, choose sender identity from the destination:

- Clo/bot is for messages to Bayu or operational updates meant for Bayu.
- Bayu/user is for messages to anyone else or to a team channel, including reminders sent on Bayu's behalf.
- Human-to-human reminders still use `message_intent: "outbound_message"` with `allow_identity_fallback: false`.
- Do not use `message_intent: "reminder"` for Bayu-on-behalf strategist/staff reminders; this MCP maps that intent to Clo/bot.
- Do not use bot-only `slack_post_message` or `slack_reply_to_thread` for Bayu-authored or Bayu-on-behalf messages.

For `slack_send_message`, `slack_schedule_message`, `slack_edit_message`, and `slack_delete_message`:

- Use `message_intent` explicitly when the user's intent is clear.
- Do not silently change a user-authored outbound message into a bot-authored message.
- Set `allow_identity_fallback: true` only when the user allows fallback identity.
- Before replying to a conversation, read the latest channel/thread context.

## Slack mrkdwn For Outgoing Text

The MCP server sends raw Slack `text`. Compose Slack-native `mrkdwn`, not GitHub/CommonMark Markdown.

| Intent | Slack mrkdwn |
| --- | --- |
| Bold | `*text*` |
| Italic | `_text_` |
| Strikethrough | `~text~` |
| Inline code | `` `code` `` |
| Code block | `` ```text``` `` |
| Quote | `> text` |
| Link | `<https://example.com|label>` |
| Bare URL | `<https://example.com>` |
| User mention | `<@U123456>` |
| Channel mention | `<#C123456>` |
| User group mention | `<!subteam^S123456>` |
| Here/channel/everyone | `<!here>`, `<!channel>`, `<!everyone>` |
| Date token | `<!date^1716180000^{date_short_pretty} at {time}|May 20 at 09:00>` |
| Lists | `- item` or `1. item` |

Do not use:

| Avoid | Use instead |
| --- | --- |
| `**bold**` | `*bold*` |
| `[label](https://example.com)` | `<https://example.com|label>` |
| `~~text~~` | `~text~` |
| `# Heading` | `*Short heading*` or plain text |
| Bare `@name` | `<@USER_ID>` after resolving the user |
| Bare `#channel` | `<#CHANNEL_ID>` after resolving the channel |

Escape literal `&`, `<`, and `>` as `&amp;`, `&lt;`, and `&gt;`. Do not escape Slack entity syntax such as `<@U123456>` or `<https://example.com|label>`.

## Output Pattern

For summaries, answer from the Slack evidence actually read. Mention the channel/thread/file context when useful, and include concise access limitations such as unreadable private history, unsupported file type, or missing search scope.

For write drafts, provide only the final Slack-ready `mrkdwn` text unless the user asks for alternatives. For actual sends, call the write tool with the chosen `message_intent`.
