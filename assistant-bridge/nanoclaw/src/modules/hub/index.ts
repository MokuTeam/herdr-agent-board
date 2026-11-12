/**
 * Hub module: connects NanoClaw to the assistant bridge, which holds the team hub connection
 * (agent-board repository, assistant-bridge/). Phase 1: the host assistant's topics only.
 *
 * Registers, only when HUB_BRIDGE_SOCKET is set (in .env or the process environment):
 *   - a `hub` channel adapter, for its lifecycle only: setup() starts the bridge connection once
 *     the central DB is up, teardown() stops it. Nothing is ever routed to channel type `hub`.
 *   - the `hub_request` delivery action, which the agents' hub_send and hub_inbox tools
 *     (container/agent-runner/src/mcp-tools/hub.ts) write as system rows.
 *   - NANOCLAW_HUB=1 in this process's environment. Host-runtime agents inherit it, so their MCP
 *     server registers the hub tools; container agents do not get it in phase 1.
 * Without HUB_BRIDGE_SOCKET nothing is registered and NanoClaw runs as it did.
 *
 * HUB_BRIDGE_HOST_GROUP is the host assistant's agent group, by its folder. Its Telegram chat comes
 * from its wiring. A place is `host:<thread id>` for a topic of that chat, or `host:<platform id>`
 * for the chat itself.
 */
import type { ChannelAdapter } from '../../channels/adapter.js';
import { getChannelAdapter, registerChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getMessagingGroupAgentByPair, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { insertMessage } from '../../db/session-db.js';
import { registerDeliveryAction } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { effectiveSessionModeFor } from '../../router.js';
import { openInboundDb, resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { type CallAnswer, type HubCore, type HubHost, type HubRow, startHubCore, type WriteOutcome } from './core.js';
import type { InboxArgs, Location, SendArgs, Topic } from './protocol.js';

const ENV_KEYS = ['HUB_BRIDGE_SOCKET', 'HUB_BRIDGE_HOST_GROUP'];
const fileEnv = readEnvFile(ENV_KEYS);
const socketPath = process.env.HUB_BRIDGE_SOCKET || fileEnv.HUB_BRIDGE_SOCKET || '';
const hostFolder = process.env.HUB_BRIDGE_HOST_GROUP || fileEnv.HUB_BRIDGE_HOST_GROUP || '';

let core: HubCore | null = null;

interface HostChat {
  agentGroupId: string;
  mg: MessagingGroup;
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
}

/** The host assistant's agent group and its Telegram chat, read fresh each time (rewiring is picked up). */
function hostChat(): HostChat | null {
  if (!hostFolder) return null;
  const group = getAgentGroupByFolder(hostFolder);
  if (!group) return null;
  const mg = getMessagingGroupsByAgentGroup(group.id).find((m) => m.channel_type === 'telegram');
  if (!mg) return null;
  const wiring = getMessagingGroupAgentByPair(mg.id, group.id);
  return { agentGroupId: group.id, mg, sessionMode: wiring?.session_mode ?? 'shared' };
}

/** The thread a place names in the host chat: null for the chat itself, undefined when it is not this chat. */
function threadOf(chat: HostChat, at: Location): string | null | undefined {
  const id = at.slice('host:'.length);
  if (id === chat.mg.platform_id) return null;
  if (id.startsWith(`${chat.mg.platform_id}:`)) return id;
  return undefined;
}

/** The session for a topic of the host chat, as the router would pick or make it. */
function sessionFor(chat: HostChat, threadId: string | null): Session {
  const threads = getChannelAdapter('telegram')?.supportsThreads ?? true;
  const mode = effectiveSessionModeFor(chat.sessionMode, threads, chat.mg.is_group, threadId);
  return resolveSession(chat.agentGroupId, chat.mg.id, threadId, mode).session;
}

const host: HubHost = {
  topics(): Topic[] {
    const chat = hostChat();
    if (!chat) return [];
    const topics: Topic[] = [{ id: chat.mg.platform_id }];
    if (hasTable(getDb(), 'telegram_topics')) {
      const rows = getDb()
        .prepare('SELECT thread_id, name FROM telegram_topics WHERE platform_id = ?')
        .all(chat.mg.platform_id) as Array<{ thread_id: string; name: string }>;
      for (const r of rows) topics.push(r.name ? { id: r.thread_id, name: r.name } : { id: r.thread_id });
    }
    return topics;
  },

  write(at: Location, row: HubRow): WriteOutcome {
    const chat = hostChat();
    if (!chat) return 'unknown';
    const threadId = threadOf(chat, at);
    if (threadId === undefined) return 'unknown';
    const session = sessionFor(chat, threadId);
    const db = openInboundDb(chat.agentGroupId, session.id);
    let exists = false;
    try {
      exists = !!db.prepare('SELECT 1 FROM messages_in WHERE id = ?').get(row.id);
    } finally {
      db.close();
    }
    if (exists) return 'exists';
    writeSessionMessage(chat.agentGroupId, session.id, {
      id: row.id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: chat.mg.platform_id,
      channelType: 'telegram',
      threadId,
      content: JSON.stringify({ text: row.text, sender: 'Hub', senderId: null }),
      processAfter: row.processAfter ?? null,
      trigger: row.trigger,
    });
    return 'written';
  },

  async wake(at: Location): Promise<void> {
    const chat = hostChat();
    if (!chat) return;
    const threadId = threadOf(chat, at);
    if (threadId === undefined) return;
    // wakeContainer never throws; a failed spawn leaves the row due, and the host sweep wakes it.
    await wakeContainer(sessionFor(chat, threadId));
  },

  async notify(at: Location, text: string): Promise<void> {
    const chat = hostChat();
    const threadId = chat ? threadOf(chat, at) : undefined;
    if (!chat || threadId === undefined) {
      log.warn('hub: a notice for a place that is not the host chat, dropped');
      return;
    }
    const adapter = getChannelAdapter('telegram');
    if (!adapter) throw new Error('the Telegram channel is not connected');
    await adapter.deliver(chat.mg.platform_id, threadId, { kind: 'chat', content: { text } });
  },

  log(level, msg, extra): void {
    log[level](msg, extra);
  },
};

/** A hub tool's request from an agent, answered by the bridge. Only the host assistant's sessions may ask. */
async function answer(content: Record<string, unknown>, session: Session): Promise<CallAnswer> {
  if (!core) return { ok: false, text: 'not sent: the hub bridge is off' };
  const chat = hostChat();
  if (!chat || session.agent_group_id !== chat.agentGroupId || session.messaging_group_id !== chat.mg.id)
    return { ok: false, text: "not sent: hub tools work only in the host assistant's topics" };
  // The place is the session's own, never what the agent wrote.
  const at = `host:${session.thread_id ?? chat.mg.platform_id}` as Location;
  const args = content.args && typeof content.args === 'object' ? (content.args as Record<string, unknown>) : {};
  if (content.op === 'send') return core.call(at, 'send', args as unknown as SendArgs);
  if (content.op === 'inbox') return core.call(at, 'inbox', args as InboxArgs);
  return { ok: false, text: 'not sent: an unknown hub request' };
}

function hubAdapter(): ChannelAdapter {
  return {
    name: 'hub',
    channelType: 'hub',
    supportsThreads: false,
    async setup(): Promise<void> {
      core = startHubCore({ socketPath, host });
      log.info('hub: module started', { hostGroup: hostFolder || '(not set)' });
    },
    async teardown(): Promise<void> {
      core?.stop();
      core = null;
    },
    isConnected(): boolean {
      return core?.connected() ?? false;
    },
    // Nothing is routed to channel type `hub`: the agents answer the hub with hub_send.
    async deliver(): Promise<string | undefined> {
      return undefined;
    },
  };
}

if (socketPath) {
  process.env.NANOCLAW_HUB = '1';
  registerChannelAdapter('hub', { factory: () => hubAdapter() });
  registerDeliveryAction('hub_request', async (content, session, inDb) => {
    const requestId = typeof content.requestId === 'string' ? content.requestId : '';
    if (!requestId) {
      log.warn('hub_request without requestId', { sessionId: session.id });
      return;
    }
    const reply = await answer(content, session);
    // trigger=0: the tool call waits for this row; it must not wake the agent.
    insertMessage(inDb, {
      id: `hub-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ type: 'hub_response', requestId, ok: reply.ok, text: reply.text }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  });
}
