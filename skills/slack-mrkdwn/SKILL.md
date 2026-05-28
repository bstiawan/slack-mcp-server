---
name: slack-mrkdwn
description: Use when composing, reviewing, converting, or sending Slack messages through this Slack MCP server so outgoing text uses Slack-native mrkdwn instead of GitHub/CommonMark Markdown.
---

# Slack mrkdwn

Use this skill before calling Slack write tools such as `slack_send_message`, `slack_post_message`, `slack_reply_to_thread`, `slack_schedule_message`, or any draft/canvas tool that accepts final Slack text.

## Contract

- Write Slack-native `mrkdwn`, not GitHub/CommonMark Markdown.
- Do not assume this MCP server converts Markdown into Slack `mrkdwn`.
- Pass the final mrkdwn string as the tool's `text` value.
- Preserve existing Slack entity tokens exactly, such as `<@U...>`, `<#C...>`, and `<!subteam^S...>`.
- If a Slack ID cannot be resolved, use plain text and state that the mention was not resolved instead of using bare `@name` or `#channel`.

## Common Syntax

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
| Here mention | `<!here>` |
| Channel-wide mention | `<!channel>` |
| Everyone mention | `<!everyone>` |
| Date token | `<!date^1716180000^{date_short_pretty} at {time}|May 20 at 09:00>` |
| Bulleted list | `- item` |
| Numbered list | `1. item` |

## Do Not Use

| Avoid | Use instead |
| --- | --- |
| `**bold**` | `*bold*` |
| `[label](https://example.com)` | `<https://example.com|label>` |
| `~~text~~` | `~text~` |
| `# Heading` | `*Short heading*` or plain text |
| Bare `@name` | `<@USER_ID>` after resolving the user |
| Bare `#channel` | `<#CHANNEL_ID>` after resolving the channel |

## Message Pattern

```text
*Short heading*
One concise sentence of context.

- Main update with <https://example.com|link label>
- Owner: <@U123456>
- Next step: `exact action`
```

Tool call text should look like:

```json
{
  "target": "C123456",
  "text": "*Launch update*\\nPlease review <https://example.com/spec|the spec>.\\n\\n- Owner: <@U123456>\\n- Status: `ready`",
  "message_intent": "outbound_message"
}
```

## Escaping

- Escape literal `&` as `&amp;`.
- Escape literal `<` as `&lt;`.
- Escape literal `>` as `&gt;`.
- Do not escape Slack entity syntax itself, for example `<@U123456>` or `<https://example.com|label>`.

## Safety

- Avoid `<!here>`, `<!channel>`, and `<!everyone>` unless the user explicitly requested broad notification.
- Keep Slack posts short and scannable.
- Use short standalone headings sparingly; format them as `*Short heading*`.
