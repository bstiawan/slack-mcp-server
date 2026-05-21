import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';

// Mock fetch globally
(global as any).fetch = jest.fn();

const mockRegisterTool = jest.fn();
const mockConnect = jest.fn();

// Mock the MCP SDK modules
(jest as any).unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    registerTool: jest.fn((...args: any[]) => mockRegisterTool(...args)),
    connect: mockConnect,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
    sessionId: 'test-session-id',
    onclose: null,
    handleRequest: jest.fn(),
  })),
}));

jest.mock('express', () => {
  const mockApp = {
    use: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    listen: jest.fn(),
  };
  const mockExpress = jest.fn(() => mockApp);
  (mockExpress as any).json = jest.fn();
  return mockExpress;
});

// Mock process.env
const originalEnv = process.env;
const originalArgv = process.argv;

beforeEach(() => {
  jest.resetModules();
  (global as any).fetch.mockReset();
  process.env = {
    ...originalEnv,
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_TEAM_ID: 'T123456',
  };
  process.argv = originalArgv;
});

afterEach(() => {
  process.env = originalEnv;
  process.argv = originalArgv;
  jest.clearAllMocks();
});

describe('SlackClient', () => {
  let SlackClient: any;
  let slackClient: any;
  const mockFetch = (global as any).fetch;

  beforeEach(async () => {
    const indexModule = await import('../index.js');
    SlackClient = indexModule.SlackClient;
    slackClient = new SlackClient('xoxb-test-token');
  });

  test('SlackClient constructor creates headers', () => {
    expect(slackClient).toHaveProperty('tokens');
    expect((slackClient as any).tokens).toEqual({
      bot: 'xoxb-test-token',
      user: undefined,
    });
  });

  test('routes read calls through user token when configured and write calls through bot token', async () => {
    const hybridClient = new SlackClient('xoxb-test-token', 'xoxp-user-token');

    mockFetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, messages: [] }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, channel: 'C123456' }),
      });

    await hybridClient.getChannelHistory('C123456', 10);
    await hybridClient.postMessage('C123456', 'Hello from bot');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxp-user-token',
          'Content-Type': 'application/json',
        },
      })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('falls back to bot token for read calls when optional user token is absent', async () => {
    delete process.env.SLACK_USER_TOKEN;
    const botOnlyClient = new SlackClient('xoxb-test-token');

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, messages: [] }),
    });

    await botOnlyClient.getChannelHistory('C123456', 10);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('reports hybrid Slack capabilities from configured tokens', async () => {
    const hybridClient = new SlackClient('xoxb-test-token', 'xoxp-user-token', 'T123456');

    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, user_id: 'UBOT' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, user_id: 'UUSER' }) });

    await expect(hybridClient.getWorkspaceAccessReport()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        configured: expect.objectContaining({
          bot: true,
          user: true,
          team_id: 'T123456',
        }),
        auth_test: {
          bot: { ok: true, user_id: 'UBOT' },
          user: { ok: true, user_id: 'UUSER' },
        },
        limitations: expect.arrayContaining([
          expect.stringContaining('Bot tokens cannot read arbitrary non-member conversation history'),
        ]),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://slack.com/api/auth.test',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }) })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/auth.test',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }) })
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('reports optional user token as unavailable without disabling compatibility tools', async () => {
    const botOnlyClient = new SlackClient('xoxb-test-token');

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, user_id: 'UBOT' }),
    });

    await expect(botOnlyClient.getWorkspaceAccessReport()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        configured: expect.objectContaining({
          bot: true,
          user: false,
          team_id: 'T123456',
        }),
        auth_test: {
          bot: { ok: true, user_id: 'UBOT' },
        },
      }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/auth.test',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }) })
    );
  });

  test('getChannels with predefined IDs', async () => {
    process.env.SLACK_CHANNEL_IDS = 'C123456,C789012';
    mockFetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          ok: true,
          channel: { id: 'C123456', name: 'general', is_archived: false },
        }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          ok: true,
          channel: { id: 'C789012', name: 'random', is_archived: false },
        }),
      });

    const result = await slackClient.getChannels();

    expect(result).toEqual({
      ok: true,
      channels: [
        { id: 'C123456', name: 'general', is_archived: false },
        { id: 'C789012', name: 'random', is_archived: false },
      ],
      response_metadata: { next_cursor: '' },
    });
  });

  test('getChannels with API call', async () => {
    delete process.env.SLACK_CHANNEL_IDS;
    const mockResponse = {
      ok: true,
      channels: [
        { id: 'C123456', name: 'general', is_archived: false },
        { id: 'C789012', name: 'random', is_archived: false },
      ],
      response_metadata: { next_cursor: '' },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getChannels();

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.list'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('postMessage successful response', async () => {
    const mockResponse = {
      ok: true,
      channel: 'C123456',
      ts: '1234567890.123456',
      message: {
        text: 'Hello, world!',
        user: 'U123456',
        ts: '1234567890.123456',
      },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.postMessage('C123456', 'Hello, world!');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: 'C123456',
          text: 'Hello, world!',
        }),
      }
    );
  });

  test('postReply successful response', async () => {
    const mockResponse = {
      ok: true,
      channel: 'C123456',
      ts: '1234567890.123457',
      message: {
        text: 'Reply text',
        user: 'U123456',
        ts: '1234567890.123457',
        thread_ts: '1234567890.123456',
      },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.postReply('C123456', '1234567890.123456', 'Reply text');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: 'C123456',
          thread_ts: '1234567890.123456',
          text: 'Reply text',
        }),
      }
    );
  });

  test('addReaction successful response', async () => {
    const mockResponse = {
      ok: true,
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.addReaction('C123456', '1234567890.123456', 'thumbsup');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/reactions.add',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: 'C123456',
          timestamp: '1234567890.123456',
          name: 'thumbsup',
        }),
      }
    );
  });

  test('getChannelHistory successful response', async () => {
    const mockResponse = {
      ok: true,
      messages: [
        {
          type: 'message',
          user: 'U123456',
          text: 'Hello',
          ts: '1234567890.123456',
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getChannelHistory('C123456', 10);

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('getChannelHistory sends expanded pagination and time range args', async () => {
    const mockResponse = {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: 'next-cursor' },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getChannelHistory(
      'C123456',
      25,
      'page-cursor',
      '1716180000.000000',
      '1716266400.000000',
      true
    );

    expect(result).toEqual(mockResponse);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://slack.com/api/conversations.history');
    expect(url).toContain('channel=C123456');
    expect(url).toContain('limit=25');
    expect(url).toContain('cursor=page-cursor');
    expect(url).toContain('oldest=1716180000.000000');
    expect(url).toContain('latest=1716266400.000000');
    expect(url).toContain('inclusive=true');
  });

  test('getThreadReplies successful response', async () => {
    const mockResponse = {
      ok: true,
      messages: [
        {
          type: 'message',
          user: 'U123456',
          text: 'Parent message',
          ts: '1234567890.123456',
        },
        {
          type: 'message',
          user: 'U789012',
          text: 'Reply message',
          ts: '1234567890.123457',
          thread_ts: '1234567890.123456',
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getThreadReplies('C123456', '1234567890.123456');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.replies'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('getThreadRepliesWithRole can use user token', async () => {
    const hybridClient = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const mockResponse = {
      ok: true,
      messages: [],
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await hybridClient.getThreadRepliesWithRole('C123456', '1234567890.123456', 'user', 25, 'page-cursor');

    expect(result).toEqual(mockResponse);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://slack.com/api/conversations.replies');
    expect(url).toContain('limit=25');
    expect(url).toContain('cursor=page-cursor');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
  });

  test('getUsers successful response', async () => {
    const mockResponse = {
      ok: true,
      members: [
        {
          id: 'U123456',
          name: 'testuser',
          real_name: 'Test User',
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getUsers(100);

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/users.list'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('getUserProfile successful response', async () => {
    const mockResponse = {
      ok: true,
      profile: {
        real_name: 'Test User',
        email: 'test@example.com',
        phone: '+1234567890',
      },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getUserProfile('U123456');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/users.profile.get'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  test('listConversations calls Slack conversations.list with optional cursor and types', async () => {
    const mockResponse = {
      ok: true,
      channels: [{ id: 'C123456', name: 'general' }],
      response_metadata: { next_cursor: 'next-cursor' },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.listConversations(50, 'page-cursor', 'public_channel,private_channel,mpim,im');

    expect(result).toEqual(mockResponse);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://slack.com/api/conversations.list');
    expect(url).toContain('limit=50');
    expect(url).toContain('cursor=page-cursor');
    expect(url).toContain('types=public_channel%2Cprivate_channel%2Cmpim%2Cim');
  });

  test('getConversationInfo calls Slack conversations.info', async () => {
    const mockResponse = {
      ok: true,
      channel: { id: 'C123456', name: 'general', is_channel: true },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getConversationInfo('C123456');

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.info'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      })
    );
    expect(mockFetch.mock.calls[0][0]).toContain('channel=C123456');
  });

  test('getConversationMembers calls Slack conversations.members with pagination', async () => {
    const mockResponse = {
      ok: true,
      members: ['U123456', 'U789012'],
      response_metadata: { next_cursor: 'next-cursor' },
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await slackClient.getConversationMembers('C123456', 100, 'page-cursor');

    expect(result).toEqual(mockResponse);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://slack.com/api/conversations.members');
    expect(url).toContain('channel=C123456');
    expect(url).toContain('limit=100');
    expect(url).toContain('cursor=page-cursor');
  });


  test('searchConversations with user token only requests channel types covered by user scopes', async () => {
    const hybridClient = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const mockResponse = {
      ok: true,
      channels: [{ id: 'C123456', name: 'private-team' }],
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(mockResponse),
    });

    const result = await hybridClient.searchConversations('team', 20, undefined, 'user');

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      channels: [{ id: 'C123456', name: 'private-team' }],
    }));
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('types=public_channel%2Cprivate_channel');
    expect(url).not.toContain('im%2Cmpim');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.list'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
  });

  test('updateMessage and deleteMessage call Slack cleanup APIs with selected token', async () => {
    const hybridClient = new SlackClient('xoxb-test-token', 'xoxp-user-token');

    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, ts: '1234567890.123456' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, ts: '1234567890.123456' }) });

    await hybridClient.updateMessage('C123456', '1234567890.123456', 'Updated', 'user');
    await hybridClient.deleteMessage('C123456', '1234567890.123456', 'bot');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://slack.com/api/chat.update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
        body: JSON.stringify({ channel: 'C123456', ts: '1234567890.123456', text: 'Updated' }),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/chat.delete',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }),
        body: JSON.stringify({ channel: 'C123456', ts: '1234567890.123456' }),
      }),
    );
  });
});

describe('SlackRouter', () => {
  let SlackClient: any;
  let SlackRouter: any;
  const mockFetch = (global as any).fetch;

  beforeEach(async () => {
    const indexModule = await import('../index.js');
    SlackClient = indexModule.SlackClient;
    SlackRouter = indexModule.SlackRouter;
  });

  test('readChannel prefers user token and returns compact routing trace', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, messages: [{ text: 'hello' }] }),
    });

    const result = await router.readChannel('C123456', 10);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      messages: [{ text: 'hello' }],
      routing: expect.objectContaining({
        selected_token_role: 'user',
        fallback_attempts: [],
      }),
    }));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
  });

  test('readChannel safely falls back from user to bot on access error', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: false, error: 'not_in_channel' }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, messages: [{ text: 'bot-visible' }] }),
      });

    const result = await router.readChannel('C123456', 10);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      messages: [{ text: 'bot-visible' }],
      routing: expect.objectContaining({
        selected_token_role: 'bot',
        fallback_attempts: [{ token_role: 'user', error: 'not_in_channel' }],
      }),
    }));
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }),
      }),
    );
  });

  test('sendMessage uses user identity for outbound messages', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, channel: 'C123456' }),
    });

    const result = await router.sendMessage('C123456', 'Hello', 'outbound_message');

    expect(result.routing.selected_token_role).toBe('user');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
        body: JSON.stringify({ channel: 'C123456', text: 'Hello' }),
      }),
    );
  });

  test('sendMessage uses bot identity for notifications', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, channel: 'C123456' }),
    });

    const result = await router.sendMessage('C123456', 'Reminder', 'notification');

    expect(result.routing.selected_token_role).toBe('bot');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }),
      }),
    );
  });

  test('sendMessage does not silently fall back from user to bot unless allowed', async () => {
    const client = new SlackClient('xoxb-test-token');
    const router = new SlackRouter(client);

    const result = await router.sendMessage('C123456', 'Hello', 'outbound_message');

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: 'missing_token',
      routing: expect.objectContaining({
        selected_token_role: 'user',
        fallback_attempts: [{ token_role: 'user', error: 'missing_token' }],
      }),
    }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('sendMessage falls back to bot when identity fallback is explicitly allowed', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: false, error: 'missing_scope' }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, channel: 'C123456' }),
      });

    const result = await router.sendMessage('C123456', 'Hello', 'outbound_message', undefined, true);

    expect(result.routing).toEqual(expect.objectContaining({
      selected_token_role: 'bot',
      fallback_attempts: [{ token_role: 'user', error: 'missing_scope' }],
    }));
  });

  test('searchConversations routes through user metadata first', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token', 'T123456');
    const router = new SlackRouter(client);

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, channels: [{ id: 'C123456', name: 'announcements' }] }),
    });

    const result = await router.searchConversations('announce');

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      channels: [{ id: 'C123456', name: 'announcements' }],
      routing: expect.objectContaining({ selected_token_role: 'user' }),
    }));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.list'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
  });

  test('searchPublicAndPrivate falls back to bounded history scan when search API is blocked', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: false, error: 'missing_scope' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: false, error: 'not_allowed_token_type' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, messages: [{ text: 'alpha launch update', ts: '1.1' }] }) });

    const result = await router.searchPublicAndPrivate('alpha in:<#C123456|general>', undefined, 10);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      fallback_search: 'history_scan',
      messages: expect.objectContaining({
        matches: [expect.objectContaining({ text: 'alpha launch update' })],
      }),
      routing: expect.objectContaining({
        access_limitation: expect.stringContaining('History-scan fallback is bounded'),
      }),
    }));
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('https://slack.com/api/conversations.history'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
  });

  test('readChannelByName resolves a channel and then reads history', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, channels: [{ id: 'C123456', name: 'general' }] }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, messages: [{ text: 'hello' }] }),
      });

    const result = await router.readChannelByName('general', 10);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      resolved_channel: { id: 'C123456', name: 'general' },
      messages: [{ text: 'hello' }],
    }));
  });

  test('editMessage and deleteMessage use identity-aware routing', async () => {
    const client = new SlackClient('xoxb-test-token', 'xoxp-user-token');
    const router = new SlackRouter(client);

    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, text: 'Updated' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, ts: '1234567890.123456' }) });

    const edit = await router.editMessage('C123456', '1234567890.123456', 'Updated', 'outbound_message');
    const deleted = await router.deleteMessage('C123456', '1234567890.123456', 'notification');

    expect(edit.routing.selected_token_role).toBe('user');
    expect(deleted.routing.selected_token_role).toBe('bot');
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://slack.com/api/chat.update',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxp-user-token' }),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/chat.delete',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }),
      }),
    );
  });

  test('unsupported draft and canvas actions return structured responses', async () => {
    const client = new SlackClient('xoxb-test-token');
    const router = new SlackRouter(client);

    await expect(router.sendMessageDraft()).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: 'unsupported_action',
      supported_alternative: expect.stringContaining('slack_send_message'),
    }));
    await expect(router.createCanvas()).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: 'unsupported_action',
    }));
  });
});

describe('createSlackServer', () => {
  const getRegisteredTool = (server: any, name: string) => {
    const registration = server.registerTool.mock.calls.find((call: any[]) => call[0] === name);
    expect(registration).toBeDefined();
    return registration!;
  };

  test('createSlackServer returns server instance', async () => {
    const { createSlackServer, SlackClient } = await import('../index.js');
    
    const mockSlackClient = new SlackClient('xoxb-test-token');
    const server = createSlackServer(mockSlackClient);

    // Just test that the server is created and defined
    expect(server).toBeDefined();
    expect(typeof server).toBe('object');
  });

  test('registers hybrid inspection tools and existing compatibility tools', async () => {
    const { createSlackServer, SlackClient } = await import('../index.js');

    const server: any = createSlackServer(new SlackClient('xoxb-test-token'));

    expect(server.registerTool.mock.calls.map((call: any[]) => call[0])).toEqual(
      expect.arrayContaining([
        'slack_get_workspace_access_report',
        'slack_list_conversations',
        'slack_get_conversation_info',
        'slack_get_conversation_members',
        'slack_list_channels',
        'slack_post_message',
        'slack_reply_to_thread',
        'slack_add_reaction',
        'slack_get_channel_history',
        'slack_get_thread_replies',
        'slack_get_users',
        'slack_get_user_profile',
        'slack_read_user_profile',
        'slack_search_channels',
        'slack_read_channel',
        'slack_read_thread',
        'slack_search_users',
        'slack_search_public_and_private',
        'slack_search_conversations',
        'slack_get_channel_history_by_name',
        'slack_send_message',
        'slack_edit_message',
        'slack_delete_message',
        'slack_send_message_draft',
        'slack_schedule_message',
        'slack_create_canvas',
      ])
    );
  });

  test('new list/info/members tool callbacks return Slack responses as MCP text content', async () => {
    const { createSlackServer } = await import('../index.js');
    const mockSlackClient = {
      listConversations: jest.fn<any>().mockResolvedValue({ ok: true, channels: [{ id: 'C123456' }] }),
      getConversationInfo: jest.fn<any>().mockResolvedValue({ ok: true, channel: { id: 'C123456' } }),
      getConversationMembers: jest.fn<any>().mockResolvedValue({ ok: true, members: ['U123456'] }),
    };

    const server: any = createSlackServer(mockSlackClient as any);

    const listHandler = getRegisteredTool(server, 'slack_list_conversations')[2];
    const infoHandler = getRegisteredTool(server, 'slack_get_conversation_info')[2];
    const membersHandler = getRegisteredTool(server, 'slack_get_conversation_members')[2];

    await expect(listHandler({ limit: 50, cursor: 'page-cursor', types: 'public_channel,private_channel', exclude_archived: true, token_role: 'user' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, channels: [{ id: 'C123456' }] }) }],
    });
    await expect(infoHandler({ channel_id: 'C123456', include_locale: true, include_num_members: true, token_role: 'user' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, channel: { id: 'C123456' } }) }],
    });
    await expect(membersHandler({ channel_id: 'C123456', limit: 100, cursor: 'page-cursor', token_role: 'user' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, members: ['U123456'] }) }],
    });

    expect(mockSlackClient.listConversations).toHaveBeenCalledWith(50, 'page-cursor', 'public_channel,private_channel', true, 'user');
    expect(mockSlackClient.getConversationInfo).toHaveBeenCalledWith('C123456', true, true, 'user');
    expect(mockSlackClient.getConversationMembers).toHaveBeenCalledWith('C123456', 100, 'page-cursor', 'user');
  });

  test('history tool passes expanded args while keeping channel and limit compatibility', async () => {
    const { createSlackServer } = await import('../index.js');
    const mockSlackClient = {
      getChannelHistory: jest.fn<any>().mockResolvedValue({ ok: true, messages: [] }),
    };

    const server: any = createSlackServer(mockSlackClient as any);

    const historyHandler = getRegisteredTool(server, 'slack_get_channel_history')[2];
    await expect(
      historyHandler({
        channel_id: 'C123456',
        limit: 25,
        cursor: 'page-cursor',
        oldest: '1716180000.000000',
        latest: '1716266400.000000',
        inclusive: true,
        token_role: 'user',
      })
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, messages: [] }) }],
    });

    expect(mockSlackClient.getChannelHistory).toHaveBeenCalledWith(
      'C123456',
      25,
      'page-cursor',
      '1716180000.000000',
      '1716266400.000000',
      true,
      'user'
    );
  });

  test('compatibility list channels tool still delegates to getChannels', async () => {
    const { createSlackServer } = await import('../index.js');
    const mockSlackClient = {
      getChannels: jest.fn<any>().mockResolvedValue({ ok: true, channels: [] }),
    };

    const server: any = createSlackServer(mockSlackClient as any);

    const listChannelsHandler = getRegisteredTool(server, 'slack_list_channels')[2];
    await expect(listChannelsHandler({ limit: 20, cursor: 'next' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, channels: [] }) }],
    });

    expect(mockSlackClient.getChannels).toHaveBeenCalledWith(20, 'next');
  });
});

describe('parseArgs', () => {
  test('parseArgs with default values', async () => {
    process.argv = ['node', 'index.js'];
    const { parseArgs } = await import('../index.js');

    const result = parseArgs();

    expect(result).toEqual({
      transport: 'stdio',
      port: 3000,
      authToken: undefined,
    });
  });

  test('parseArgs with custom transport', async () => {
    process.argv = ['node', 'index.js', '--transport', 'http'];
    const { parseArgs } = await import('../index.js');

    const result = parseArgs();

    expect(result).toEqual({
      transport: 'http',
      port: 3000,
      authToken: undefined,
    });
  });

  test('parseArgs with custom port', async () => {
    process.argv = ['node', 'index.js', '--port', '8080'];
    const { parseArgs } = await import('../index.js');

    const result = parseArgs();

    expect(result).toEqual({
      transport: 'stdio',
      port: 8080,
      authToken: undefined,
    });
  });

  test('parseArgs with invalid transport', async () => {
    process.argv = ['node', 'index.js', '--transport', 'invalid'];
    const { parseArgs } = await import('../index.js');

    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseArgs()).toThrow('process.exit called');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: --transport must be either "stdio" or "http"');
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  test('parseArgs with invalid port', async () => {
    process.argv = ['node', 'index.js', '--port', 'invalid'];
    const { parseArgs } = await import('../index.js');

    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseArgs()).toThrow('process.exit called');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: --port must be a valid port number (1-65535)');
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });
});

describe('main', () => {
  test('main with missing env vars', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_TEAM_ID;

    const { main } = await import('../index.js');

    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(main()).rejects.toThrow('process.exit called');
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Please set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables'
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });
});

describe('HTTP Server', () => {
  test('express module can be imported', async () => {
    const express = await import('express');
    
    // Test that express module is available and mocked
    expect(express.default).toBeDefined();
    expect(typeof express.default).toBe('function');
  });

  test('SlackClient can be instantiated', async () => {
    const { SlackClient } = await import('../index.js');
    
    const mockSlackClient = new SlackClient('xoxb-test-token');
    
    // Test that SlackClient is created successfully
    expect(mockSlackClient).toBeDefined();
    expect(mockSlackClient).toHaveProperty('tokens');
  });

  test('index module exports expected functions', async () => {
    const indexModule = await import('../index.js');
    
    // Test that required exports are available
    expect(indexModule.SlackClient).toBeDefined();
    expect(indexModule.createSlackServer).toBeDefined();
    expect(indexModule.parseArgs).toBeDefined();
    expect(indexModule.main).toBeDefined();
  });
});
