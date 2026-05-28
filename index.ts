#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Type definitions for tool arguments
interface ListChannelsArgs {
  limit?: number;
  cursor?: string;
}

interface PostMessageArgs {
  channel_id: string;
  text: string;
}

interface ReplyToThreadArgs {
  channel_id: string;
  thread_ts: string;
  text: string;
}

interface AddReactionArgs {
  channel_id: string;
  timestamp: string;
  reaction: string;
}

interface GetChannelHistoryArgs {
  channel_id: string;
  limit?: number;
  cursor?: string;
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  token_role?: TokenRole;
}

interface GetThreadRepliesArgs {
  channel_id: string;
  thread_ts: string;
  token_role?: TokenRole;
}

interface GetUsersArgs {
  cursor?: string;
  limit?: number;
}

interface GetUserProfileArgs {
  user_id: string;
}

type TokenRole = "bot" | "user";
type MessageIntent = "outbound_message" | "notification" | "reminder" | "automation_update";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const FILE_AGENT_NOTE = "This message includes files. Call slack_read_file with file_id to inspect supported content.";
const ATTACHMENT_AGENT_NOTE = "This message includes Slack attachment or image block metadata. Downloadable Slack file content is only available for file IDs.";

interface RoutingTrace {
  selected_token_role: TokenRole;
  fallback_attempts: Array<{ token_role: TokenRole; error?: string }>;
  routing_reason: string;
  access_limitation?: string;
}

interface MessageFileOptions {
  include_files?: boolean;
  include_file_content?: boolean;
  max_file_bytes?: number;
  max_files?: number;
  token_role?: TokenRole;
}

function normalizedMimeType(mimetype?: string): string {
  return String(mimetype || "").split(";")[0].trim().toLowerCase();
}

function isImageFile(file: any): boolean {
  const mimetype = normalizedMimeType(file?.mimetype);
  return mimetype.startsWith("image/") || ["gif", "jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(String(file?.filetype || "").toLowerCase());
}

function isTextLikeFile(file: any): boolean {
  const mimetype = normalizedMimeType(file?.mimetype);
  return mimetype.startsWith("text/") || [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/typescript",
    "application/csv",
  ].includes(mimetype);
}

function supportedFileContentKind(file: any): "image" | "text" | "metadata_only" {
  if (isImageFile(file)) return "image";
  if (isTextLikeFile(file)) return "text";
  return "metadata_only";
}

function summarizeSlackFile(file: any): any {
  return {
    id: file?.id,
    name: file?.name,
    title: file?.title,
    mimetype: file?.mimetype,
    filetype: file?.filetype,
    pretty_type: file?.pretty_type,
    size: file?.size,
    user: file?.user,
    mode: file?.mode,
    is_external: file?.is_external,
    external_type: file?.external_type,
    alt_txt: file?.alt_txt,
    original_w: file?.original_w,
    original_h: file?.original_h,
    is_image: isImageFile(file),
    is_text_like: isTextLikeFile(file),
    supported_content_kind: supportedFileContentKind(file),
    can_read_with_slack_file_tool: Boolean(file?.id),
  };
}

function summarizeImageBlocks(blocks: any[] = []): any[] {
  const summaries: any[] = [];

  for (const block of blocks) {
    if (block?.type === "image") {
      summaries.push({
        block_id: block.block_id,
        alt_text: block.alt_text,
        title: block.title?.text,
        has_image_url: Boolean(block.image_url),
      });
    }

    if (block?.accessory?.type === "image") {
      summaries.push({
        block_id: block.block_id,
        alt_text: block.accessory.alt_text,
        title: block.accessory.title?.text,
        has_image_url: Boolean(block.accessory.image_url),
      });
    }

    for (const element of block?.elements || []) {
      if (element?.type === "image") {
        summaries.push({
          block_id: block.block_id,
          alt_text: element.alt_text,
          title: element.title?.text,
          has_image_url: Boolean(element.image_url),
        });
      }
    }
  }

  return summaries;
}

function summarizeAttachments(attachments: any[] = []): any[] {
  return attachments.map((attachment) => ({
    id: attachment?.id,
    fallback: attachment?.fallback,
    title: attachment?.title,
    text: attachment?.text,
    mimetype: attachment?.mimetype,
    filetype: attachment?.filetype,
    has_image_url: Boolean(attachment?.image_url || attachment?.thumb_url),
    has_fields: Array.isArray(attachment?.fields) && attachment.fields.length > 0,
  }));
}

function buildAttachmentSummary(message: any): any | undefined {
  const files = Array.isArray(message?.files) ? message.files.map(summarizeSlackFile) : [];
  const attachments = Array.isArray(message?.attachments) ? summarizeAttachments(message.attachments) : [];
  const imageBlocks = Array.isArray(message?.blocks) ? summarizeImageBlocks(message.blocks) : [];

  if (!files.length && !attachments.length && !imageBlocks.length) {
    return undefined;
  }

  return {
    has_files: files.length > 0,
    has_attachments: attachments.length > 0,
    has_image_blocks: imageBlocks.length > 0,
    file_count: files.length,
    attachment_count: attachments.length,
    image_block_count: imageBlocks.length,
    files,
    attachments,
    image_blocks: imageBlocks,
    agent_note: files.length > 0 ? FILE_AGENT_NOTE : ATTACHMENT_AGENT_NOTE,
  };
}

function annotateMessageForAgent(message: any): any {
  const attachmentSummary = buildAttachmentSummary(message);
  if (!attachmentSummary) {
    return message;
  }

  const annotated = {
    ...message,
    attachment_summary: attachmentSummary,
  };

  if (Array.isArray(message.files)) {
    annotated.files = attachmentSummary.files;
  }

  return annotated;
}

function annotateMessageResponse(response: any): any {
  if (!Array.isArray(response?.messages)) {
    return response;
  }

  const messages = response.messages.map(annotateMessageForAgent);
  const attachmentMessages = messages.filter((message: any) => message.attachment_summary);

  if (!attachmentMessages.length) {
    return {
      ...response,
      messages,
    };
  }

  return {
    ...response,
    messages,
    attachment_summary: {
      message_count_with_attachments: attachmentMessages.length,
      file_count: attachmentMessages.reduce((count: number, message: any) => count + (message.attachment_summary?.file_count || 0), 0),
      attachment_count: attachmentMessages.reduce((count: number, message: any) => count + (message.attachment_summary?.attachment_count || 0), 0),
      image_block_count: attachmentMessages.reduce((count: number, message: any) => count + (message.attachment_summary?.image_block_count || 0), 0),
      agent_note: "Some messages include files or attachment metadata. Call slack_read_file with a file_id to inspect supported Slack-hosted file content.",
    },
  };
}

function normalizeFileOptions(options: MessageFileOptions = {}): Required<Omit<MessageFileOptions, "token_role">> & { token_role?: TokenRole } {
  const include_file_content = Boolean(options.include_file_content);
  return {
    include_files: Boolean(options.include_files || include_file_content),
    include_file_content,
    max_file_bytes: Math.max(1, Math.min(options.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES)),
    max_files: Math.max(0, Math.min(options.max_files ?? DEFAULT_MAX_FILES, DEFAULT_MAX_FILES)),
    token_role: options.token_role,
  };
}

function toolResult(response: any): any {
  const { mcp_content, ...jsonResponse } = response || {};
  return {
    content: [
      { type: "text", text: JSON.stringify(jsonResponse) },
      ...(Array.isArray(mcp_content) ? mcp_content : []),
    ],
  };
}

export class SlackClient {
  private botHeaders: { Authorization: string; "Content-Type": string };
  private tokens: { bot: string; user?: string };
  private teamId?: string;

  constructor(
    botToken: string,
    userToken?: string,
    teamId?: string,
  ) {
    this.tokens = {
      bot: botToken,
      user: userToken || process.env.SLACK_USER_TOKEN,
    };
    this.teamId = teamId || process.env.SLACK_TEAM_ID;
    this.botHeaders = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };
  }

  private headers(tokenRole: TokenRole = "bot"): { Authorization: string; "Content-Type": string } | undefined {
    const token = this.tokens[tokenRole];
    if (!token) {
      return undefined;
    }

    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  hasToken(tokenRole: TokenRole): boolean {
    return Boolean(this.tokens[tokenRole]);
  }

  private missingToken(tokenRole: TokenRole): any {
    return {
      ok: false,
      error: "missing_token",
      needed_token_role: tokenRole,
      message: `SLACK_${tokenRole.toUpperCase()}_TOKEN is not configured`,
    };
  }

  private preferredReadToken(tokenRole?: TokenRole): TokenRole {
    return tokenRole ?? (this.tokens.user ? "user" : "bot");
  }

  private preferredMetadataToken(tokenRole?: TokenRole): TokenRole {
    return tokenRole ?? (this.tokens.user ? "user" : "bot");
  }

  async get(method: string, params: Record<string, string | number | boolean | undefined>, tokenRole: TokenRole): Promise<any> {
    const headers = this.headers(tokenRole);
    if (!headers) {
      return this.missingToken(tokenRole);
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    }

    const response = await fetch(
      `https://slack.com/api/${method}${searchParams.toString() ? `?${searchParams}` : ""}`,
      { headers },
    );

    return response.json();
  }

  async post(method: string, body: Record<string, string | number | boolean | undefined>, tokenRole: TokenRole): Promise<any> {
    const headers = this.headers(tokenRole);
    if (!headers) {
      return this.missingToken(tokenRole);
    }

    const cleanBody = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    );

    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(cleanBody),
    });

    return response.json();
  }

  private tokenStatus() {
    return {
      bot: true,
      user: Boolean(this.tokens.user),
      team_id: this.teamId ?? null,
    };
  }

  async getChannels(limit: number = 100, cursor?: string): Promise<any> {
    const predefinedChannelIds = process.env.SLACK_CHANNEL_IDS;
    if (!predefinedChannelIds) {
      const params = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: Math.min(limit, 200).toString(),
      });

      if (this.teamId) {
        params.append("team_id", this.teamId);
      }
  
      if (cursor) {
        params.append("cursor", cursor);
      }
  
      return this.get("conversations.list", Object.fromEntries(params), "bot");
    }

    const predefinedChannelIdsArray = predefinedChannelIds.split(",").map((id: string) => id.trim());
    const channels = [];

    for (const channelId of predefinedChannelIdsArray) {
      const params = new URLSearchParams({
        channel: channelId,
      });

      const data = await this.get("conversations.info", Object.fromEntries(params), "bot");

      if (data.ok && data.channel && !data.channel.is_archived) {
        channels.push(data.channel);
      }
    }

    return {
      ok: true,
      channels: channels,
      response_metadata: { next_cursor: "" },
    };
  }

  async postMessage(channel_id: string, text: string): Promise<any> {
    return this.postMessageWithRole(channel_id, text, "bot");
  }

  async postMessageWithRole(channel_id: string, text: string, token_role: TokenRole, thread_ts?: string): Promise<any> {
    return this.post("chat.postMessage", {
      channel: channel_id,
      text: text,
      thread_ts,
    }, token_role);
  }

  async postReply(
    channel_id: string,
    thread_ts: string,
    text: string,
  ): Promise<any> {
    return this.post("chat.postMessage", {
      channel: channel_id,
      thread_ts: thread_ts,
      text: text,
    }, "bot");
  }

  async addReaction(
    channel_id: string,
    timestamp: string,
    reaction: string,
  ): Promise<any> {
    return this.post("reactions.add", {
      channel: channel_id,
      timestamp: timestamp,
      name: reaction,
    }, "bot");
  }

  async getChannelHistory(
    channel_id: string,
    limit: number = 10,
    cursor?: string,
    oldest?: string,
    latest?: string,
    inclusive?: boolean,
    token_role?: TokenRole,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      limit: limit.toString(),
    });

    if (cursor) params.append("cursor", cursor);
    if (oldest) params.append("oldest", oldest);
    if (latest) params.append("latest", latest);
    if (inclusive !== undefined) params.append("inclusive", inclusive.toString());

    return this.get("conversations.history", Object.fromEntries(params), this.preferredReadToken(token_role));
  }

  async listConversations(
    limit: number = 100,
    cursor?: string,
    types: string = "public_channel,private_channel",
    exclude_archived: boolean = true,
    token_role?: TokenRole,
  ): Promise<any> {
    const params = new URLSearchParams({
      types,
      exclude_archived: exclude_archived.toString(),
      limit: Math.min(limit, 200).toString(),
    });

    if (process.env.SLACK_TEAM_ID) params.append("team_id", process.env.SLACK_TEAM_ID);
    if (cursor) params.append("cursor", cursor);

    const role = this.preferredMetadataToken(token_role);
    return this.get("conversations.list", Object.fromEntries(params), role);
  }

  async getConversationInfo(
    channel_id: string,
    include_locale?: boolean,
    include_num_members?: boolean,
    token_role?: TokenRole,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
    });

    if (include_locale !== undefined) params.append("include_locale", include_locale.toString());
    if (include_num_members !== undefined) params.append("include_num_members", include_num_members.toString());

    const role = this.preferredMetadataToken(token_role);
    return this.get("conversations.info", Object.fromEntries(params), role);
  }

  async getConversationMembers(
    channel_id: string,
    limit: number = 100,
    cursor?: string,
    token_role?: TokenRole,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      limit: Math.min(limit, 200).toString(),
    });

    if (cursor) params.append("cursor", cursor);

    const role = this.preferredMetadataToken(token_role);
    return this.get("conversations.members", Object.fromEntries(params), role);
  }

  async getWorkspaceAccessReport(): Promise<any> {
    const authResults = await Promise.all(
      (["bot", "user"] as TokenRole[])
        .filter((role) => Boolean(this.tokens[role]))
        .map(async (role) => {
          const headers = this.headers(role);
          if (!headers) {
            return [role, this.missingToken(role)];
          }
          const response = await fetch("https://slack.com/api/auth.test", { headers });
          const data = await response.json();
          return [role, data];
        }),
    );

    const report: any = {
      ok: true,
      configured: this.tokenStatus(),
      auth_test: Object.fromEntries(authResults),
      capabilities: {
        bot: "Existing writes and conversations visible to the bot.",
        user: "Optional broader public-channel history reads; private conversations only where the user has access.",
      },
      limitations: [
        "Bot tokens cannot read arbitrary non-member conversation history.",
        "User tokens do not grant arbitrary private channel, DM, or MPDM history.",
      ],
    };

    return report;
  }

  async getThreadReplies(channel_id: string, thread_ts: string): Promise<any> {
    return this.getThreadRepliesWithRole(channel_id, thread_ts, "bot");
  }

  async getThreadRepliesWithRole(
    channel_id: string,
    thread_ts: string,
    token_role: TokenRole,
    limit?: number,
    cursor?: string,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      ts: thread_ts,
    });

    if (limit !== undefined) params.append("limit", Math.min(limit, 200).toString());
    if (cursor) params.append("cursor", cursor);

    return this.get("conversations.replies", Object.fromEntries(params), token_role);
  }

  async getUsers(limit: number = 100, cursor?: string, token_role: TokenRole = "bot"): Promise<any> {
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
    });

    if (this.teamId) {
      params.append("team_id", this.teamId);
    }

    if (cursor) {
      params.append("cursor", cursor);
    }

    return this.get("users.list", Object.fromEntries(params), token_role);
  }

  async getUserProfile(user_id: string, token_role: TokenRole = "bot"): Promise<any> {
    const params = new URLSearchParams({
      user: user_id,
      include_labels: "true",
    });

    return this.get("users.profile.get", Object.fromEntries(params), token_role);
  }

  async authTest(token_role: TokenRole): Promise<any> {
    return this.get("auth.test", {}, token_role);
  }

  async searchMessages(
    query: string,
    count: number = 20,
    page?: number,
    token_role: TokenRole = "user",
    sort?: string,
    sort_dir?: string,
  ): Promise<any> {
    return this.get("search.messages", {
      query,
      count: Math.min(count, 100),
      page,
      sort,
      sort_dir,
    }, token_role);
  }

  async getFileInfo(file_id: string, token_role: TokenRole = "bot"): Promise<any> {
    return this.get("files.info", {
      file: file_id,
    }, token_role);
  }

  async downloadFile(url: string, token_role: TokenRole, max_bytes: number = DEFAULT_MAX_FILE_BYTES): Promise<any> {
    const headers = this.headers(token_role);
    if (!headers) {
      return this.missingToken(token_role);
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return {
        ok: false,
        error: response.status === 403 ? "not_visible" : response.status === 404 ? "file_not_found" : "file_download_failed",
        status: response.status,
      };
    }

    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && Number(contentLength) > max_bytes) {
      return {
        ok: false,
        error: "file_too_large",
        size: Number(contentLength),
        max_bytes,
      };
    }

    const readableBody = response.body as any;
    if (readableBody?.getReader) {
      const reader = readableBody.getReader();
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const chunk = Buffer.from(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > max_bytes) {
          await reader.cancel?.();
          return {
            ok: false,
            error: "file_too_large",
            size: totalBytes,
            max_bytes,
          };
        }
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      return {
        ok: true,
        data: buffer.toString("base64"),
        size: buffer.byteLength,
        mimeType: response.headers?.get?.("content-type")?.split(";")[0],
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > max_bytes) {
      return {
        ok: false,
        error: "file_too_large",
        size: arrayBuffer.byteLength,
        max_bytes,
      };
    }

    return {
      ok: true,
      data: Buffer.from(arrayBuffer).toString("base64"),
      size: arrayBuffer.byteLength,
      mimeType: response.headers?.get?.("content-type")?.split(";")[0],
    };
  }

  async scheduleMessage(
    channel_id: string,
    text: string,
    post_at: number,
    token_role: TokenRole,
    thread_ts?: string,
  ): Promise<any> {
    return this.post("chat.scheduleMessage", {
      channel: channel_id,
      text,
      post_at,
      thread_ts,
    }, token_role);
  }

  async updateMessage(
    channel_id: string,
    ts: string,
    text: string,
    token_role: TokenRole,
  ): Promise<any> {
    return this.post("chat.update", {
      channel: channel_id,
      ts,
      text,
    }, token_role);
  }

  async deleteMessage(
    channel_id: string,
    ts: string,
    token_role: TokenRole,
  ): Promise<any> {
    return this.post("chat.delete", {
      channel: channel_id,
      ts,
    }, token_role);
  }

  async searchConversations(
    query: string,
    limit: number = 20,
    cursor?: string,
    token_role: TokenRole = "user",
  ): Promise<any> {
    const conversationTypes = token_role === "bot"
      ? "public_channel,private_channel,im,mpim"
      : "public_channel,private_channel";
    const response = await this.listConversations(Math.min(limit, 200), cursor, conversationTypes, true, token_role);
    if (!response?.ok) {
      return response;
    }

    const normalizedQuery = query.replace(/^#/, "").toLowerCase();
    return {
      ...response,
      channels: (response.channels || []).filter((channel: any) =>
        channel.name?.toLowerCase().includes(normalizedQuery) ||
        channel.id?.toLowerCase() === normalizedQuery,
      ),
      warning: "Slack's Conversations API does not support normal workspace server-side channel-name search; this result filters one bounded conversations.list page.",
    };
  }
}

export class SlackRouter {
  constructor(private slackClient: SlackClient) {}

  private isAccessError(response: any): boolean {
    return [
      "missing_token",
      "missing_scope",
      "not_in_channel",
      "channel_not_found",
      "not_authed",
      "invalid_auth",
      "account_inactive",
      "not_allowed_token_type",
      "not_visible",
      "file_not_found",
      "no_permission",
      "access_denied",
      "team_access_not_granted",
    ].includes(response?.error);
  }

  private withRouting(response: any, routing: RoutingTrace): any {
    return {
      ...response,
      routing,
    };
  }

  private unsupported(action: string, supportedAlternative: string): any {
    return {
      ok: false,
      error: "unsupported_action",
      action,
      supported_alternative: supportedAlternative,
      routing: {
        selected_token_role: "bot",
        fallback_attempts: [],
        routing_reason: "Slack Web API support is not available for this action in this MCP server.",
      },
    };
  }

  private async tryRoles(
    roles: TokenRole[],
    routingReason: string,
    action: (role: TokenRole) => Promise<any>,
  ): Promise<any> {
    const fallback_attempts: RoutingTrace["fallback_attempts"] = [];
    let lastResponse: any;

    for (const role of roles) {
      if (!this.slackClient.hasToken(role)) {
        fallback_attempts.push({ token_role: role, error: "missing_token" });
        lastResponse = {
          ok: false,
          error: "missing_token",
          needed_token_role: role,
        };
        continue;
      }

      const response = await action(role);
      lastResponse = response;
      const routing: RoutingTrace = {
        selected_token_role: role,
        fallback_attempts,
        routing_reason: routingReason,
      };

      if (response?.ok || !this.isAccessError(response)) {
        return this.withRouting(response, routing);
      }

      fallback_attempts.push({ token_role: role, error: response?.error });
    }

    return this.withRouting(lastResponse || { ok: false, error: "no_token_available" }, {
      selected_token_role: roles[roles.length - 1] || "bot",
      fallback_attempts,
      routing_reason: routingReason,
      access_limitation: "No configured token role could complete this Slack action.",
    });
  }

  private fileRoles(token_role?: TokenRole): TokenRole[] {
    return token_role ? [token_role] : ["user", "bot"];
  }

  private sanitizeFileInfoResponse(response: any): any {
    if (!response?.ok || !response.file) {
      return response;
    }

    return {
      ok: true,
      file: summarizeSlackFile(response.file),
      comments: response.comments,
      response_metadata: response.response_metadata,
    };
  }

  async getFileInfo(file_id: string, token_role?: TokenRole): Promise<any> {
    return this.tryRoles(this.fileRoles(token_role), "Read Slack file metadata with the best available files:read token.", async (role) => {
      const response = await this.slackClient.getFileInfo(file_id, role);
      return this.sanitizeFileInfoResponse(response);
    });
  }

  private async readFileWithRole(file_id: string, token_role: TokenRole, max_bytes: number): Promise<any> {
    const info = await this.slackClient.getFileInfo(file_id, token_role);
    if (!info?.ok || !info.file) {
      return info;
    }

    const file = info.file;
    const sanitizedFile = summarizeSlackFile(file);
    const contentKind = supportedFileContentKind(file);
    if (contentKind === "metadata_only") {
      return {
        ok: true,
        file: sanitizedFile,
        content_status: "metadata_only",
        access_limitation: "Only image and text-like Slack files are downloaded in this MCP server.",
      };
    }

    if (typeof file.size === "number" && file.size > max_bytes) {
      return {
        ok: true,
        file: sanitizedFile,
        content_status: "skipped",
        access_limitation: `File size ${file.size} exceeds max_file_bytes ${max_bytes}.`,
      };
    }

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      return {
        ok: true,
        file: sanitizedFile,
        content_status: "metadata_only",
        access_limitation: "Slack did not return an authenticated download URL for this file.",
      };
    }

    const download = await this.slackClient.downloadFile(downloadUrl, token_role, max_bytes);
    if (!download?.ok) {
      return {
        ...download,
        file: sanitizedFile,
      };
    }

    const mimeType = download.mimeType || sanitizedFile.mimetype || "application/octet-stream";
    const mcpContent = contentKind === "image"
      ? [{ type: "image", data: download.data, mimeType }]
      : [{
          type: "resource",
          resource: {
            uri: `slack://file/${file_id}`,
            mimeType,
            text: Buffer.from(download.data, "base64").toString("utf8"),
          },
        }];

    return {
      ok: true,
      file: sanitizedFile,
      content_status: "downloaded",
      downloaded_bytes: download.size,
      mcp_content: mcpContent,
    };
  }

  async readFile(file_id: string, token_role?: TokenRole, max_bytes: number = DEFAULT_MAX_FILE_BYTES): Promise<any> {
    return this.tryRoles(this.fileRoles(token_role), "Read Slack file content with the best available files:read token.", (role) =>
      this.readFileWithRole(file_id, role, Math.max(1, Math.min(max_bytes, DEFAULT_MAX_FILE_BYTES))),
    );
  }

  private collectFileRefs(messages: any[]): Array<{ file_id: string; message_ts?: string }> {
    const seen = new Set<string>();
    const refs: Array<{ file_id: string; message_ts?: string }> = [];

    for (const message of messages) {
      for (const file of message.attachment_summary?.files || []) {
        if (file.id && !seen.has(file.id)) {
          seen.add(file.id);
          refs.push({ file_id: file.id, message_ts: message.ts });
        }
      }
    }

    return refs;
  }

  async enrichMessageResponse(response: any, options: MessageFileOptions = {}): Promise<any> {
    const annotated = annotateMessageResponse(response);
    const fileOptions = normalizeFileOptions(options);
    if (!annotated?.ok || !Array.isArray(annotated.messages) || !fileOptions.include_files) {
      return annotated;
    }

    const refs = this.collectFileRefs(annotated.messages);
    const selectedRefs = refs.slice(0, fileOptions.max_files);
    const mcpContent: any[] = [];
    const fileResults: any[] = [];

    for (const ref of selectedRefs) {
      const fileResponse = fileOptions.include_file_content
        ? await this.readFile(ref.file_id, fileOptions.token_role, fileOptions.max_file_bytes)
        : await this.getFileInfo(ref.file_id, fileOptions.token_role);
      const { mcp_content, ...serializableFileResponse } = fileResponse || {};

      if (Array.isArray(mcp_content)) {
        mcpContent.push(...mcp_content);
      }

      fileResults.push({
        file_id: ref.file_id,
        message_ts: ref.message_ts,
        ok: Boolean(serializableFileResponse?.ok),
        file: serializableFileResponse?.file,
        content_status: serializableFileResponse?.content_status || (serializableFileResponse?.ok ? "metadata" : "error"),
        error: serializableFileResponse?.error,
        access_limitation: serializableFileResponse?.access_limitation,
        routing: serializableFileResponse?.routing,
      });
    }

    const filesById = new Map(fileResults.map((fileResult) => [fileResult.file_id, fileResult]));
    const messages = annotated.messages.map((message: any) => {
      if (!message.attachment_summary?.files?.length) {
        return message;
      }

      const files = message.attachment_summary.files.map((file: any) => ({
        ...file,
        enriched_file: filesById.get(file.id)?.file,
        read_status: filesById.get(file.id)?.content_status,
      }));

      return {
        ...message,
        files,
        attachment_summary: {
          ...message.attachment_summary,
          files,
        },
      };
    });

    const skippedByLimit = refs.slice(fileOptions.max_files).map((ref) => ({
      file_id: ref.file_id,
      message_ts: ref.message_ts,
      content_status: "skipped",
      access_limitation: `Skipped because max_files is ${fileOptions.max_files}.`,
    }));

    const enrichedResponse: any = {
      ...annotated,
      messages,
      files: fileResults,
      downloaded_files: fileResults.filter((fileResult) => fileResult.content_status === "downloaded"),
      skipped_files: [
        ...fileResults.filter((fileResult) => fileOptions.include_file_content && fileResult.content_status !== "downloaded"),
        ...skippedByLimit,
      ],
    };

    if (mcpContent.length) {
      enrichedResponse.mcp_content = mcpContent;
    }

    return enrichedResponse;
  }

  async readUserProfile(user_id?: string): Promise<any> {
    const roles: TokenRole[] = this.slackClient.hasToken("user") ? ["user", "bot"] : ["bot"];
    return this.tryRoles(roles, "Resolve user profile with the best available identity token.", async (role) => {
      if (user_id) {
        return this.slackClient.getUserProfile(user_id, role);
      }

      const auth = await this.slackClient.authTest(role);
      if (!auth?.ok || !auth.user_id) {
        return auth;
      }

      return this.slackClient.getUserProfile(auth.user_id, role);
    });
  }

  async searchChannels(query?: string, limit: number = 100, cursor?: string): Promise<any> {
    const response = await this.tryRoles(
      ["user", "bot"],
      "Resolve channel names and IDs through metadata access.",
      (role) => this.slackClient.listConversations(limit, cursor, "public_channel,private_channel", true, role),
    );

    const conversations = response.channels || response.conversations || [];
    const normalizedQuery = query?.replace(/^#/, "").toLowerCase();
    const channels = normalizedQuery
      ? conversations.filter((channel: any) =>
          channel.name?.toLowerCase().includes(normalizedQuery) ||
          channel.id?.toLowerCase() === normalizedQuery,
        )
      : conversations;

    return {
      ...response,
      channels,
    };
  }

  async searchConversations(
    query: string,
    token_role?: TokenRole,
    limit: number = 20,
    cursor?: string,
  ): Promise<any> {
    const preferredRoles: TokenRole[] = token_role ? [token_role] : ["user", "bot"];
    return this.tryRoles(preferredRoles, "Search conversations by name with user metadata first, then bot metadata.", (role) =>
      this.slackClient.searchConversations(query, limit, cursor, role),
    );
  }

  async readChannel(
    channel_id: string,
    limit: number = 100,
    oldest?: string,
    latest?: string,
    cursor?: string,
    fileOptions?: MessageFileOptions,
  ): Promise<any> {
    const response = await this.tryRoles(["user", "bot"], "Read channel discussion with the broadest safe read token first.", (role) =>
      this.slackClient.getChannelHistory(channel_id, limit, cursor, oldest, latest, undefined, role),
    );
    return this.enrichMessageResponse(response, fileOptions);
  }

  async readThread(channel_id: string, thread_ts: string, limit: number = 50, cursor?: string, fileOptions?: MessageFileOptions): Promise<any> {
    const response = await this.tryRoles(["user", "bot"], "Read thread replies with the broadest safe read token first.", (role) =>
      this.slackClient.getThreadRepliesWithRole(channel_id, thread_ts, role, limit, cursor),
    );
    return this.enrichMessageResponse(response, fileOptions);
  }

  async readChannelByName(
    channel_name: string,
    limit: number = 100,
    oldest?: string,
    latest?: string,
    cursor?: string,
    fileOptions?: MessageFileOptions,
  ): Promise<any> {
    const search = await this.searchConversations(channel_name, undefined, 20);
    const conversations = search.channels || search.conversations || [];
    const normalizedName = channel_name.replace(/^#/, "").toLowerCase();
    const selected = conversations.find((channel: any) => channel.name?.toLowerCase() === normalizedName) || conversations[0];

    if (!selected?.id) {
      return {
        ok: false,
        error: "channel_not_found",
        query: channel_name,
        routing: search.routing,
      };
    }

    const history = await this.readChannel(selected.id, limit, oldest, latest, cursor, fileOptions);
    return {
      ...history,
      resolved_channel: selected,
      routing: {
        ...history.routing,
        fallback_attempts: [
          ...(search.routing?.fallback_attempts || []),
          ...(history.routing?.fallback_attempts || []),
        ],
        routing_reason: "Resolved channel by name, then read channel discussion with best safe read token.",
      },
    };
  }

  async searchUsers(query?: string, limit: number = 100, cursor?: string): Promise<any> {
    const response = await this.tryRoles(["user", "bot"], "Search users through the best available user-directory token.", (role) =>
      this.slackClient.getUsers(limit, cursor, role),
    );

    const members = response.members || [];
    const normalizedQuery = query?.toLowerCase();
    return {
      ...response,
      members: normalizedQuery
        ? members.filter((member: any) => {
            const profile = member.profile || {};
            return [
              member.id,
              member.name,
              member.real_name,
              profile.real_name,
              profile.display_name,
              profile.email,
            ].some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
          })
        : members,
    };
  }

  async searchPublicAndPrivate(
    query: string,
    channel_types?: string,
    count: number = 20,
    page?: number,
  ): Promise<any> {
    if (!query) {
      return this.unsupported("slack_search_public_and_private", "Provide a Slack search query.");
    }

    const response = await this.tryRoles(["user", "bot"], "Search Slack messages using the best available search token.", (role) =>
      this.slackClient.searchMessages(query, count, page, role),
    );

    if (!response?.ok && this.isAccessError(response)) {
      return this.searchMessagesViaHistory(query, channel_types, count, response);
    }

    if (channel_types) {
      return {
        ...response,
        routing: {
          ...response.routing,
          access_limitation: "channel_types is accepted for skill compatibility, but Slack search filtering is governed by the query and token access.",
        },
      };
    }

    return response;
  }

  private extractSearchQueryText(query: string): string {
    return query
      .replace(/in:<#[^>]+>/g, "")
      .replace(/in:[^\s]+/g, "")
      .replace(/from:<@[^>]+>/g, "")
      .replace(/to:<@[^>]+>/g, "")
      .replace(/\bis:thread\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private extractSearchChannelIds(query: string): string[] {
    const ids = new Set<string>();
    for (const match of query.matchAll(/in:<#([^>|]+)(?:\|[^>]+)?>/g)) {
      ids.add(match[1]);
    }
    for (const match of query.matchAll(/in:(C[A-Z0-9]+)/g)) {
      ids.add(match[1]);
    }
    return [...ids];
  }

  private async searchMessagesViaHistory(
    query: string,
    channel_types: string | undefined,
    count: number,
    originalResponse: any,
  ): Promise<any> {
    const searchText = this.extractSearchQueryText(query);
    if (!searchText) {
      return {
        ...originalResponse,
        routing: {
          ...originalResponse.routing,
          access_limitation: "Slack search was unavailable and the query did not contain plain text that can be matched through history reads.",
        },
      };
    }

    let channelIds = this.extractSearchChannelIds(query);
    let searchRouting = originalResponse.routing;

    if (channelIds.length === 0) {
      const conversationSearch = await this.searchConversations(searchText.split(" ")[0], undefined, 10);
      searchRouting = conversationSearch.routing || searchRouting;
      const conversations = conversationSearch.channels || conversationSearch.conversations || [];
      channelIds = conversations
        .map((conversation: any) => conversation.id)
        .filter(Boolean)
        .slice(0, 5);
    }

    const matches: any[] = [];
    const readErrors: any[] = [];

    for (const channelId of channelIds.slice(0, 5)) {
      const history = await this.readChannel(channelId, 100);
      if (!history?.ok) {
        readErrors.push({ channel_id: channelId, error: history?.error });
        continue;
      }

      for (const message of history.messages || []) {
        if (String(message.text || "").toLowerCase().includes(searchText)) {
          matches.push({
            ...message,
            channel: { id: channelId },
          });
          if (matches.length >= Math.min(count, 100)) {
            break;
          }
        }
      }

      if (matches.length >= Math.min(count, 100)) {
        break;
      }
    }

    return {
      ok: true,
      fallback_search: "history_scan",
      query,
      channel_types,
      messages: {
        matches,
        pagination: {
          total_count: matches.length,
          page: 1,
          per_page: Math.min(count, 100),
          page_count: 1,
        },
      },
      read_errors: readErrors,
      routing: {
        selected_token_role: "user",
        fallback_attempts: [
          ...(originalResponse.routing?.fallback_attempts || []),
          ...(searchRouting?.fallback_attempts || []),
        ],
        routing_reason: "Slack search.messages was unavailable; scanned recent history from resolved channels instead.",
        access_limitation: "History-scan fallback is bounded to up to 5 resolved channels and 100 recent messages per channel.",
      },
    };
  }

  private writeRoleForIntent(message_intent: MessageIntent = "outbound_message"): TokenRole {
    return message_intent === "outbound_message" ? "user" : "bot";
  }

  async sendMessage(
    target: string,
    text: string,
    message_intent: MessageIntent = "outbound_message",
    thread_ts?: string,
    allow_identity_fallback: boolean = false,
  ): Promise<any> {
    const preferredRole = this.writeRoleForIntent(message_intent);
    const roles: TokenRole[] = allow_identity_fallback && preferredRole === "user" ? ["user", "bot"] : [preferredRole];

    return this.tryRoles(roles, `Send ${message_intent} with identity-aware routing.`, (role) =>
      this.slackClient.postMessageWithRole(target, text, role, thread_ts),
    );
  }

  async editMessage(
    channel_id: string,
    ts: string,
    text: string,
    message_intent: MessageIntent = "outbound_message",
    allow_identity_fallback: boolean = false,
  ): Promise<any> {
    const preferredRole = this.writeRoleForIntent(message_intent);
    const roles: TokenRole[] = allow_identity_fallback && preferredRole === "user" ? ["user", "bot"] : [preferredRole];

    return this.tryRoles(roles, `Edit message for ${message_intent} with identity-aware routing.`, (role) =>
      this.slackClient.updateMessage(channel_id, ts, text, role),
    );
  }

  async deleteMessage(
    channel_id: string,
    ts: string,
    message_intent: MessageIntent = "outbound_message",
    allow_identity_fallback: boolean = false,
  ): Promise<any> {
    const preferredRole = this.writeRoleForIntent(message_intent);
    const roles: TokenRole[] = allow_identity_fallback && preferredRole === "user" ? ["user", "bot"] : [preferredRole];

    return this.tryRoles(roles, `Delete message for ${message_intent} with identity-aware routing.`, (role) =>
      this.slackClient.deleteMessage(channel_id, ts, role),
    );
  }

  async scheduleMessage(
    target: string,
    text: string,
    post_at: number,
    message_intent: MessageIntent = "outbound_message",
    thread_ts?: string,
    allow_identity_fallback: boolean = false,
  ): Promise<any> {
    const preferredRole = this.writeRoleForIntent(message_intent);
    const roles: TokenRole[] = allow_identity_fallback && preferredRole === "user" ? ["user", "bot"] : [preferredRole];

    return this.tryRoles(roles, `Schedule ${message_intent} with identity-aware routing.`, (role) =>
      this.slackClient.scheduleMessage(target, text, post_at, role, thread_ts),
    );
  }

  async sendMessageDraft(): Promise<any> {
    return this.unsupported("slack_send_message_draft", "Use slack_send_message for immediate sends, or draft the text in chat.");
  }

  async createCanvas(): Promise<any> {
    return this.unsupported("slack_create_canvas", "Return the content in chat or send it as a Slack message.");
  }
}

export function createSlackServer(slackClient: SlackClient): McpServer {
  const slackRouter = new SlackRouter(slackClient);
  const server = new McpServer({
    name: "Slack MCP Server",
    version: "1.0.0",
  });

  // Register all Slack tools using the modern API
  server.registerTool(
    "slack_list_channels",
    {
      title: "List Slack Channels",
      description: "List public and private channels that the bot is a member of, or pre-defined channels in the workspace with pagination",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of channels to return (default 100, max 200)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
      },
    },
    async ({ limit, cursor }) => {
      const response = await slackClient.getChannels(limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_post_message",
    {
      title: "Post Slack Message",
      description: "Post a new message to a Slack channel or direct message to user",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel or user to post to"),
        text: z.string().describe("The message text to post"),
      },
    },
    async ({ channel_id, text }) => {
      const response = await slackClient.postMessage(channel_id, text);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_reply_to_thread",
    {
      title: "Reply to Slack Thread",
      description: "Reply to a specific message thread in Slack",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the thread"),
        thread_ts: z.string().describe("The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it."),
        text: z.string().describe("The reply text"),
      },
    },
    async ({ channel_id, thread_ts, text }) => {
      const response = await slackClient.postReply(channel_id, thread_ts, text);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_add_reaction",
    {
      title: "Add Slack Reaction",
      description: "Add a reaction emoji to a message",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the message"),
        timestamp: z.string().describe("The timestamp of the message to react to"),
        reaction: z.string().describe("The name of the emoji reaction (without ::)"),
      },
    },
    async ({ channel_id, timestamp, reaction }) => {
      const response = await slackClient.addReaction(channel_id, timestamp, reaction);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_channel_history",
    {
      title: "Get Slack Channel History",
      description: "Get recent messages from a channel with pagination and time-window filters",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel"),
        limit: z.number().optional().default(10).describe("Number of messages to retrieve (default 10)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        oldest: z.string().optional().describe("Only messages after this Unix timestamp are included"),
        latest: z.string().optional().describe("Only messages before this Unix timestamp are included"),
        inclusive: z.boolean().optional().describe("Include messages matching oldest or latest timestamps"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user token when configured, otherwise bot"),
        include_files: z.boolean().optional().default(false).describe("Fetch Slack file metadata for messages with files"),
        include_file_content: z.boolean().optional().default(false).describe("Download supported image/text file content and append MCP media/resource content"),
        max_file_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download per file, capped at 10 MB"),
        max_files: z.number().optional().default(DEFAULT_MAX_FILES).describe("Maximum files to inspect, capped at 10"),
      },
    },
    async ({ channel_id, limit, cursor, oldest, latest, inclusive, token_role, include_files, include_file_content, max_file_bytes, max_files }) => {
      const response = await slackClient.getChannelHistory(channel_id, limit, cursor, oldest, latest, inclusive, token_role);
      const enriched = await slackRouter.enrichMessageResponse(response, { include_files, include_file_content, max_file_bytes, max_files, token_role });
      return toolResult(enriched);
    }
  );

  server.registerTool(
    "slack_get_workspace_access_report",
    {
      title: "Get Slack Workspace Access Report",
      description: "Inspect configured Slack tokens and workspace access using raw Slack API responses",
      inputSchema: {},
    },
    async () => {
      const response = await slackClient.getWorkspaceAccessReport();
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_list_conversations",
    {
      title: "List Slack Conversations",
      description: "List Slack conversations with optional type and token-role selection",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of conversations to return (default 100, max 200)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        types: z.string().optional().default("public_channel,private_channel").describe("Conversation types, comma-separated"),
        exclude_archived: z.boolean().optional().default(true).describe("Whether archived conversations are excluded"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user token when configured, otherwise bot"),
      },
    },
    async ({ limit, cursor, types, exclude_archived, token_role }) => {
      const response = await slackClient.listConversations(limit, cursor, types, exclude_archived, token_role);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_conversation_info",
    {
      title: "Get Slack Conversation Info",
      description: "Get Slack conversation metadata",
      inputSchema: {
        channel_id: z.string().describe("The ID of the conversation"),
        include_locale: z.boolean().optional().describe("Include locale information"),
        include_num_members: z.boolean().optional().describe("Include member count information"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user token when configured, otherwise bot"),
      },
    },
    async ({ channel_id, include_locale, include_num_members, token_role }) => {
      const response = await slackClient.getConversationInfo(channel_id, include_locale, include_num_members, token_role);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_conversation_members",
    {
      title: "Get Slack Conversation Members",
      description: "Get Slack conversation member IDs",
      inputSchema: {
        channel_id: z.string().describe("The ID of the conversation"),
        limit: z.number().optional().default(100).describe("Maximum number of members to return (default 100, max 200)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user token when configured, otherwise bot"),
      },
    },
    async ({ channel_id, limit, cursor, token_role }) => {
      const response = await slackClient.getConversationMembers(channel_id, limit, cursor, token_role);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_file_info",
    {
      title: "Get Slack File Info",
      description: "Get sanitized Slack file metadata using the best available files:read token",
      inputSchema: {
        file_id: z.string().describe("Slack file ID, for example F123456"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user then bot fallback"),
      },
    },
    async ({ file_id, token_role }) => {
      const response = await slackRouter.getFileInfo(file_id, token_role);
      return toolResult(response);
    }
  );

  server.registerTool(
    "slack_read_file",
    {
      title: "Read Slack File",
      description: "Download supported Slack-hosted image or text-like file content and return MCP media/resource content",
      inputSchema: {
        file_id: z.string().describe("Slack file ID, for example F123456"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user then bot fallback"),
        max_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download, capped at 10 MB"),
      },
    },
    async ({ file_id, token_role, max_bytes }) => {
      const response = await slackRouter.readFile(file_id, token_role, max_bytes);
      return toolResult(response);
    }
  );

  server.registerTool(
    "slack_get_thread_replies",
    {
      title: "Get Slack Thread Replies",
      description: "Get all replies in a message thread",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the thread"),
        thread_ts: z.string().describe("The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it."),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to bot for backward compatibility"),
        include_files: z.boolean().optional().default(false).describe("Fetch Slack file metadata for messages with files"),
        include_file_content: z.boolean().optional().default(false).describe("Download supported image/text file content and append MCP media/resource content"),
        max_file_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download per file, capped at 10 MB"),
        max_files: z.number().optional().default(DEFAULT_MAX_FILES).describe("Maximum files to inspect, capped at 10"),
      },
    },
    async ({ channel_id, thread_ts, token_role, include_files, include_file_content, max_file_bytes, max_files }) => {
      const response = token_role
        ? await slackClient.getThreadRepliesWithRole(channel_id, thread_ts, token_role)
        : await slackClient.getThreadReplies(channel_id, thread_ts);
      const enriched = await slackRouter.enrichMessageResponse(response, { include_files, include_file_content, max_file_bytes, max_files, token_role });
      return toolResult(enriched);
    }
  );

  server.registerTool(
    "slack_get_users",
    {
      title: "Get Slack Users",
      description: "Get a list of all users in the workspace with their basic profile information",
      inputSchema: {
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        limit: z.number().optional().default(100).describe("Maximum number of users to return (default 100, max 200)"),
      },
    },
    async ({ cursor, limit }) => {
      const response = await slackClient.getUsers(limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_user_profile",
    {
      title: "Get Slack User Profile",
      description: "Get detailed profile information for a specific user",
      inputSchema: {
        user_id: z.string().describe("The ID of the user"),
      },
    },
    async ({ user_id }) => {
      const response = await slackClient.getUserProfile(user_id);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_read_user_profile",
    {
      title: "Read Slack User Profile",
      description: "Read the current user's Slack profile by default, or a specific user's profile when user_id is provided",
      inputSchema: {
        user_id: z.string().optional().describe("Optional Slack user ID. When omitted, reads the profile for the best configured identity token."),
      },
    },
    async ({ user_id }) => {
      const response = await slackRouter.readUserProfile(user_id);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_search_channels",
    {
      title: "Search Slack Channels",
      description: "Resolve Slack channel names and IDs using the best available metadata token",
      inputSchema: {
        query: z.string().optional().describe("Channel name, partial name, or channel ID to search for"),
        limit: z.number().optional().default(100).describe("Maximum channels to inspect (default 100, max 200 for normal Slack APIs)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
      },
    },
    async ({ query, limit, cursor }) => {
      const response = await slackRouter.searchChannels(query, limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_read_channel",
    {
      title: "Read Slack Channel",
      description: "Read channel messages using intent-aware read routing",
      inputSchema: {
        channel_id: z.string().describe("The Slack channel, DM, or conversation ID"),
        limit: z.number().optional().default(100).describe("Number of messages to retrieve"),
        oldest: z.string().optional().describe("Only messages after this Unix timestamp are included"),
        latest: z.string().optional().describe("Only messages before this Unix timestamp are included"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        include_files: z.boolean().optional().default(false).describe("Fetch Slack file metadata for messages with files"),
        include_file_content: z.boolean().optional().default(false).describe("Download supported image/text file content and append MCP media/resource content"),
        max_file_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download per file, capped at 10 MB"),
        max_files: z.number().optional().default(DEFAULT_MAX_FILES).describe("Maximum files to inspect, capped at 10"),
      },
    },
    async ({ channel_id, limit, oldest, latest, cursor, include_files, include_file_content, max_file_bytes, max_files }) => {
      const response = await slackRouter.readChannel(channel_id, limit, oldest, latest, cursor, { include_files, include_file_content, max_file_bytes, max_files });
      return toolResult(response);
    }
  );

  server.registerTool(
    "slack_read_thread",
    {
      title: "Read Slack Thread",
      description: "Read thread replies using intent-aware read routing",
      inputSchema: {
        channel_id: z.string().describe("The Slack channel, DM, or conversation ID"),
        thread_ts: z.string().describe("The timestamp of the parent message"),
        limit: z.number().optional().default(50).describe("Number of replies to retrieve"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        include_files: z.boolean().optional().default(false).describe("Fetch Slack file metadata for messages with files"),
        include_file_content: z.boolean().optional().default(false).describe("Download supported image/text file content and append MCP media/resource content"),
        max_file_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download per file, capped at 10 MB"),
        max_files: z.number().optional().default(DEFAULT_MAX_FILES).describe("Maximum files to inspect, capped at 10"),
      },
    },
    async ({ channel_id, thread_ts, limit, cursor, include_files, include_file_content, max_file_bytes, max_files }) => {
      const response = await slackRouter.readThread(channel_id, thread_ts, limit, cursor, { include_files, include_file_content, max_file_bytes, max_files });
      return toolResult(response);
    }
  );

  server.registerTool(
    "slack_search_users",
    {
      title: "Search Slack Users",
      description: "Search Slack users by ID, name, display name, real name, or email where available",
      inputSchema: {
        query: z.string().optional().describe("User name, display name, real name, email, or ID"),
        limit: z.number().optional().default(100).describe("Maximum users to inspect"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
      },
    },
    async ({ query, limit, cursor }) => {
      const response = await slackRouter.searchUsers(query, limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_search_public_and_private",
    {
      title: "Search Slack Messages",
      description: "Search Slack messages using the best available search token",
      inputSchema: {
        query: z.string().describe("Slack search query"),
        channel_types: z.string().optional().describe("Accepted for skill compatibility; actual coverage is governed by Slack search and token access"),
        count: z.number().optional().default(20).describe("Number of search results to request"),
        page: z.number().optional().describe("Search result page"),
      },
    },
    async ({ query, channel_types, count, page }) => {
      const response = await slackRouter.searchPublicAndPrivate(query, channel_types, count, page);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_search_conversations",
    {
      title: "Search Slack Conversations",
      description: "Search Slack conversations by name using user metadata first, then bot metadata, with bounded filtering",
      inputSchema: {
        query: z.string().describe("Conversation name, partial name, or ID to search for"),
        token_role: z.enum(["bot", "user"]).optional().describe("Token role to use; defaults to user token when configured, otherwise bot"),
        limit: z.number().optional().default(20).describe("Maximum conversations to inspect"),
        cursor: z.string().optional().describe("Pagination cursor for the next page of results"),
        search_channel_types: z.string().optional().describe("Accepted for compatibility but ignored by the bot/user metadata fallback"),
      },
    },
    async ({ query, token_role, limit, cursor }) => {
      const response = await slackRouter.searchConversations(query, token_role, limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_channel_history_by_name",
    {
      title: "Get Slack Channel History By Name",
      description: "Resolve a channel by name, then read its message history with intent-aware token routing",
      inputSchema: {
        channel_name: z.string().describe("Channel name, with or without leading #"),
        limit: z.number().optional().default(100).describe("Number of messages to retrieve"),
        oldest: z.string().optional().describe("Only messages after this Unix timestamp are included"),
        latest: z.string().optional().describe("Only messages before this Unix timestamp are included"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        include_files: z.boolean().optional().default(false).describe("Fetch Slack file metadata for messages with files"),
        include_file_content: z.boolean().optional().default(false).describe("Download supported image/text file content and append MCP media/resource content"),
        max_file_bytes: z.number().optional().default(DEFAULT_MAX_FILE_BYTES).describe("Maximum bytes to download per file, capped at 10 MB"),
        max_files: z.number().optional().default(DEFAULT_MAX_FILES).describe("Maximum files to inspect, capped at 10"),
      },
    },
    async ({ channel_name, limit, oldest, latest, cursor, include_files, include_file_content, max_file_bytes, max_files }) => {
      const response = await slackRouter.readChannelByName(channel_name, limit, oldest, latest, cursor, { include_files, include_file_content, max_file_bytes, max_files });
      return toolResult(response);
    }
  );

  server.registerTool(
    "slack_send_message",
    {
      title: "Send Slack Message",
      description: "Send a Slack message using identity-aware routing",
      inputSchema: {
        target: z.string().describe("Slack channel, DM, user, or conversation ID to send to"),
        text: z.string().describe("Message text"),
        thread_ts: z.string().optional().describe("Thread timestamp for replies. Omit for normal posts."),
        message_intent: z.enum(["outbound_message", "notification", "reminder", "automation_update"]).optional().default("outbound_message").describe("Intent used to select user or bot identity"),
        allow_identity_fallback: z.boolean().optional().default(false).describe("Allow a user-authored send to fall back to bot identity when user identity cannot send"),
      },
    },
    async ({ target, text, thread_ts, message_intent, allow_identity_fallback }) => {
      const response = await slackRouter.sendMessage(target, text, message_intent, thread_ts, allow_identity_fallback);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_edit_message",
    {
      title: "Edit Slack Message",
      description: "Edit a Slack message using identity-aware routing. Slack only allows editing messages authored by the selected identity.",
      inputSchema: {
        channel_id: z.string().describe("Channel containing the message"),
        ts: z.string().describe("Timestamp of the message to edit"),
        text: z.string().describe("Replacement message text"),
        message_intent: z.enum(["outbound_message", "notification", "reminder", "automation_update"]).optional().default("outbound_message").describe("Intent used to select user or bot identity"),
        allow_identity_fallback: z.boolean().optional().default(false).describe("Allow user identity to fall back to bot identity when user identity cannot edit"),
      },
    },
    async ({ channel_id, ts, text, message_intent, allow_identity_fallback }) => {
      const response = await slackRouter.editMessage(channel_id, ts, text, message_intent, allow_identity_fallback);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_delete_message",
    {
      title: "Delete Slack Message",
      description: "Delete a Slack message using identity-aware routing. Slack only allows deleting messages deletable by the selected identity.",
      inputSchema: {
        channel_id: z.string().describe("Channel containing the message"),
        ts: z.string().describe("Timestamp of the message to delete"),
        message_intent: z.enum(["outbound_message", "notification", "reminder", "automation_update"]).optional().default("outbound_message").describe("Intent used to select user or bot identity"),
        allow_identity_fallback: z.boolean().optional().default(false).describe("Allow user identity to fall back to bot identity when user identity cannot delete"),
      },
    },
    async ({ channel_id, ts, message_intent, allow_identity_fallback }) => {
      const response = await slackRouter.deleteMessage(channel_id, ts, message_intent, allow_identity_fallback);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_schedule_message",
    {
      title: "Schedule Slack Message",
      description: "Schedule a Slack message using identity-aware routing",
      inputSchema: {
        target: z.string().describe("Slack channel, DM, user, or conversation ID to send to"),
        text: z.string().describe("Message text"),
        post_at: z.number().describe("Unix timestamp for when Slack should post the message"),
        thread_ts: z.string().optional().describe("Thread timestamp for scheduled replies. Omit for normal posts."),
        message_intent: z.enum(["outbound_message", "notification", "reminder", "automation_update"]).optional().default("outbound_message").describe("Intent used to select user or bot identity"),
        allow_identity_fallback: z.boolean().optional().default(false).describe("Allow a user-authored schedule to fall back to bot identity when user identity cannot schedule"),
      },
    },
    async ({ target, text, post_at, thread_ts, message_intent, allow_identity_fallback }) => {
      const response = await slackRouter.scheduleMessage(target, text, post_at, message_intent, thread_ts, allow_identity_fallback);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_send_message_draft",
    {
      title: "Create Slack Message Draft",
      description: "Return a structured unsupported response because Slack Web API does not expose draft creation for this server",
      inputSchema: {
        target: z.string().describe("Intended Slack destination"),
        text: z.string().describe("Draft text"),
        thread_ts: z.string().optional().describe("Thread timestamp if this draft would reply to a thread"),
      },
    },
    async () => {
      const response = await slackRouter.sendMessageDraft();
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_create_canvas",
    {
      title: "Create Slack Canvas",
      description: "Return a structured unsupported response because Slack Canvas creation is not implemented in this server",
      inputSchema: {
        title: z.string().describe("Canvas title"),
        content: z.string().describe("Canvas content"),
        channel_id: z.string().optional().describe("Optional Slack channel destination"),
      },
    },
    async () => {
      const response = await slackRouter.createCanvas();
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  return server;
}

async function runStdioServer(slackClient: SlackClient) {
  console.error("Starting Slack MCP Server with stdio transport...");
  const server = createSlackServer(slackClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Slack MCP Server running on stdio");
}

async function runHttpServer(slackClient: SlackClient, port: number = 3000, authToken?: string) {
  console.error(`Starting Slack MCP Server with Streamable HTTP transport on port ${port}...`);
  
  const app = express();
  app.use(express.json());

  // Authorization middleware
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authToken) {
      // No auth token configured, skip authorization
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unauthorized: Missing or invalid Authorization header',
        },
        id: null,
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    if (token !== authToken) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unauthorized: Invalid token',
        },
        id: null,
      });
    }

    next();
  };

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Handle POST requests for client-to-server communication
  app.post('/mcp', authMiddleware, async (req, res) => {
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && req.body?.method === 'initialize') {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID
            transports[sessionId] = transport;
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        const server = createSlackServer(slackClient);
        // Connect to the MCP server
        await server.connect(transport);
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via Streamable HTTP
  app.get('/mcp', authMiddleware, handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete('/mcp', authMiddleware, handleSessionRequest);

  // Health endpoint - no authentication required
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Slack MCP Server',
      version: '1.0.0'
    });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.error(`Slack MCP Server running on http://0.0.0.0:${port}/mcp`);
  });

  return server;
}

export function parseArgs() {
  const args = process.argv.slice(2);
  let transport = 'stdio'; // default
  let port = 3000;
  let authToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transport' && i + 1 < args.length) {
      transport = args[i + 1];
      i++; // skip next argument
    } else if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++; // skip next argument
    } else if (args[i] === '--token' && i + 1 < args.length) {
      authToken = args[i + 1];
      i++; // skip next argument
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node index.js [options]

Options:
  --transport <type>     Transport type: 'stdio' or 'http' (default: stdio)
  --port <number>        Port for HTTP server when using Streamable HTTP transport (default: 3000)
  --token <token>   Bearer token for HTTP authorization (optional, can also use AUTH_TOKEN env var)
  --help, -h             Show this help message

Environment Variables:
  AUTH_TOKEN             Bearer token for HTTP authorization (fallback if --token not provided)

Examples:
  node index.js                                    # Use stdio transport (default)
  node index.js --transport stdio                  # Use stdio transport explicitly
  node index.js --transport http                   # Use Streamable HTTP transport on port 3000
  node index.js --transport http --port 8080       # Use Streamable HTTP transport on port 8080
  node index.js --transport http --token mytoken   # Use Streamable HTTP transport with custom auth token
  AUTH_TOKEN=mytoken node index.js --transport http   # Use Streamable HTTP transport with auth token from env var
`);
      process.exit(0);
    }
  }

  if (transport !== 'stdio' && transport !== 'http') {
    console.error('Error: --transport must be either "stdio" or "http"');
    process.exit(1);
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Error: --port must be a valid port number (1-65535)');
    process.exit(1);
  }

  return { transport, port, authToken };
}

export async function main() {
  const { transport, port, authToken } = parseArgs();
  
  const botToken = process.env.SLACK_BOT_TOKEN;
  const teamId = process.env.SLACK_TEAM_ID;

  if (!botToken || !teamId) {
    console.error(
      "Please set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables",
    );
    process.exit(1);
  }

  const slackClient = new SlackClient(
    botToken,
    process.env.SLACK_USER_TOKEN,
    teamId,
  );
  let httpServer: any = null;

  // Setup graceful shutdown handlers
  const setupGracefulShutdown = () => {
    const shutdown = (signal: string) => {
      console.error(`\nReceived ${signal}. Shutting down gracefully...`);
      
      if (httpServer) {
        httpServer.close(() => {
          console.error('HTTP server closed.');
          process.exit(0);
        });
        
        // Force close after 5 seconds
        setTimeout(() => {
          console.error('Forcing shutdown...');
          process.exit(1);
        }, 5000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));
  };

  setupGracefulShutdown();

  if (transport === 'stdio') {
    await runStdioServer(slackClient);
  } else if (transport === 'http') {
    // Use auth token from command line, environment variable, or generate random
    let finalAuthToken = authToken || process.env.AUTH_TOKEN;
    if (!finalAuthToken) {
      finalAuthToken = randomUUID();
      console.error(`Generated auth token: ${finalAuthToken}`);
      console.error('Use this token in the Authorization header: Bearer ' + finalAuthToken);
    } else if (authToken) {
      console.error('Using provided auth token for authorization');
    } else {
      console.error('Using auth token from AUTH_TOKEN environment variable');
    }
    
    httpServer = await runHttpServer(slackClient, port, finalAuthToken);
  }
}

// Only run main() if this file is executed directly, not when imported by tests
// This handles both direct execution and global npm installation
if (import.meta.url.startsWith('file://')) {
  const currentFile = fileURLToPath(import.meta.url);
  const executedFile = process.argv[1] ? resolve(process.argv[1]) : '';
  
  // Check if this is the main module being executed
  // Don't run if we're in a test environment (jest)
  const isTestEnvironment = process.argv.some(arg => arg.includes('jest')) || 
                            process.env.NODE_ENV === 'test' ||
                            process.argv[1]?.includes('jest');
  
  const isMainModule = !isTestEnvironment && (
    currentFile === executedFile || 
    (process.argv[1] && process.argv[1].includes('slack-mcp')) ||
    (process.argv[0].includes('node') && process.argv[1] && !process.argv[1].includes('test'))
  );
  
  if (isMainModule) {
    main().catch((error) => {
      console.error("Fatal error in main():", error);
      process.exit(1);
    });
  }
}
