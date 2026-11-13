/**
 * Hub module: connects NanoClaw to the assistant bridge, which holds the team hub connection
 * (agent-board repository, assistant-bridge/). The host assistant's topics, and the agent groups
 * listed in HUB_BRIDGE_GROUPS (phase 3, design 6.2).
 *
 * Registers, only when HUB_BRIDGE_SOCKET is set (in .env or the process environment):
 *   - a `hub` channel adapter, for its lifecycle only: setup() starts the bridge connection once
 *     the central DB is up, teardown() stops it. Nothing is ever routed to channel type `hub`.
 *   - the `hub_request` delivery action, which the agents' hub_send and hub_inbox tools
 *     (container/agent-runner/src/mcp-tools/hub.ts) write as system rows.
 *   - NANOCLAW_HUB=1 in this process's environment. Host-runtime agents inherit it, so their MCP
 *     server registers the hub tools. Containers get it only for the HUB_BRIDGE_GROUPS groups
 *     (container-env.ts); other container agents never see the hub tools.
 * Without HUB_BRIDGE_SOCKET nothing is registered and NanoClaw runs as it did.
 *
 * HUB_BRIDGE_HOST_GROUP is the host assistant's agent group, by its folder. Its Telegram chat comes
 * from its wiring: HUB_BRIDGE_HOST_CHAT (a platform id, e.g. `telegram:123`) when the group is wired
 * to several Telegram chats, otherwise the private chat first, then the oldest wiring. A place is
 * `host:<thread id>` for a topic of that chat, or `host:<platform id>` for the chat itself.
 *
 * HUB_BRIDGE_GROUPS lists other agent groups by folder, comma-separated. Each one's chat is its
 * oldest Telegram wiring. A place is `group:<agent group id>` for that chat's main session, or
 * `group:<agent group id>/<thread id>` for one of its topics. The bridge decides what may go there
 * (its config's publish entries); this module only refuses groups it was not told about.
 */
import type { ChannelAdapter } from '../../channels/adapter.js';
import { getChannelAdapter, registerChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { registerContainerEnv } from '../../container-env.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
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

const ENV_KEYS = ['HUB_BRIDGE_SOCKET', 'HUB_BRIDGE_HOST_GROUP', 'HUB_BRIDGE_HOST_CHAT', 'HUB_BRIDGE_GROUPS'];
const fileEnv = readEnvFile(ENV_KEYS);
const socketPath = process.env.HUB_BRIDGE_SOCKET || fileEnv.HUB_BRIDGE_SOCKET || '';
const hostFolder = process.env.HUB_BRIDGE_HOST_GROUP || fileEnv.HUB_BRIDGE_HOST_GROUP || '';
const hostChatId = process.env.HUB_BRIDGE_HOST_CHAT || fileEnv.HUB_BRIDGE_HOST_CHAT || '';
const groupFolders = new Set(
  (process.env.HUB_BRIDGE_GROUPS || fileEnv.HUB_BRIDGE_GROUPS || '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '' && f !== hostFolder),
);

let core: HubCore | null = null;

interface HubChat {
  agentGroupId: string;
  mg: MessagingGroup;
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
}

/** A place resolved: the chat and the thread in it (null for the chat itself). */
interface Place {
  chat: HubChat;
  threadId: string | null;
  /** `host` for the host assistant's chat, `group` for a HUB_BRIDGE_GROUPS chat. */
  kind: 'host' | 'group';
}

function chatOf(agentGroupId: string, mg: MessagingGroup): HubChat {
  const wiring = getMessagingGroupAgentByPair(mg.id, agentGroupId);
  return { agentGroupId, mg, sessionMode: wiring?.session_mode ?? 'shared' };
}

/** The host assistant's agent group and its Telegram chat, read fresh each time (rewiring is picked up). */
function hostChat(): HubChat | null {
  if (!hostFolder) return null;
  const group = getAgentGroupByFolder(hostFolder);
  if (!group) return null;
  // A group can be wired to several Telegram chats (a DM plus group chats), and the query has no
  // ORDER BY: pin the chat explicitly, else prefer the private chat, then the oldest wiring.
  const chats = getMessagingGroupsByAgentGroup(group.id).filter((m) => m.channel_type === 'telegram');
  const mg = hostChatId
    ? chats.find((m) => m.platform_id === hostChatId)
    : chats.sort((a, b) => a.is_group - b.is_group || a.created_at.localeCompare(b.created_at))[0];
  if (!mg) return null;
  return chatOf(group.id, mg);
}

/** A HUB_BRIDGE_GROUPS agent group's Telegram chat (its oldest Telegram wiring), or null. */
function groupChat(agentGroupId: string): HubChat | null {
  const group = getAgentGroup(agentGroupId);
  if (!group || !groupFolders.has(group.folder)) return null;
  const mg = getMessagingGroupsByAgentGroup(group.id)
    .filter((m) => m.channel_type === 'telegram')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return mg ? chatOf(group.id, mg) : null;
}

/** The thread an id names in a chat: null for the chat itself, undefined when it is not this chat's. */
function threadIn(chat: HubChat, id: string): string | null | undefined {
  if (id === chat.mg.platform_id) return null;
  if (id.startsWith(`${chat.mg.platform_id}:`)) return id;
  return undefined;
}

/** Where a place is in NanoClaw, read fresh each time; undefined for a place this module does not serve. Exported for tests. */
export function placeOf(at: Location): Place | undefined {
  if (at.startsWith('host:')) {
    const chat = hostChat();
    if (!chat) return undefined;
    const threadId = threadIn(chat, at.slice('host:'.length));
    return threadId === undefined ? undefined : { chat, threadId, kind: 'host' };
  }
  const rest = at.slice('group:'.length);
  const slash = rest.indexOf('/');
  const chat = groupChat(slash === -1 ? rest : rest.slice(0, slash));
  if (!chat) return undefined;
  if (slash === -1) return { chat, threadId: null, kind: 'group' };
  const threadId = threadIn(chat, rest.slice(slash + 1));
  return threadId ? { chat, threadId, kind: 'group' } : undefined;
}

/** The session for a topic of a chat, as the router would pick or make it. */
function sessionFor(chat: HubChat, threadId: string | null): Session {
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
    const place = placeOf(at);
    if (!place) return 'unknown';
    const { chat, threadId } = place;
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
    const place = placeOf(at);
    if (!place) return;
    // wakeContainer never throws; a failed spawn leaves the row due, and the host sweep wakes it.
    await wakeContainer(sessionFor(place.chat, place.threadId));
  },

  async notify(at: Location, text: string): Promise<void> {
    // Notices are lines for the owner: they go to the host chat, never into another group's chat.
    const place = placeOf(at);
    if (!place || place.kind !== 'host') {
      log.warn('hub: a notice for a place that is not the host chat, dropped');
      return;
    }
    const adapter = getChannelAdapter('telegram');
    if (!adapter) throw new Error('the Telegram channel is not connected');
    await adapter.deliver(place.chat.mg.platform_id, place.threadId, { kind: 'chat', content: { text } });
  },

  log(level, msg, extra): void {
    log[level](msg, extra);
  },
};

/** The place a session is, when it is in a chat this module serves: the session's own, never what the agent wrote. Exported for tests. */
export function sessionPlace(session: Session): Location | null {
  const host = hostChat();
  if (host && session.agent_group_id === host.agentGroupId && session.messaging_group_id === host.mg.id)
    return `host:${session.thread_id ?? host.mg.platform_id}`;
  const group = groupChat(session.agent_group_id);
  if (group && session.messaging_group_id === group.mg.id)
    return session.thread_id ? `group:${group.agentGroupId}/${session.thread_id}` : `group:${group.agentGroupId}`;
  return null;
}

/** A hub tool's request from an agent, answered by the bridge. Only sessions in the chats this module serves may ask. */
async function answer(content: Record<string, unknown>, session: Session): Promise<CallAnswer> {
  if (!core) return { ok: false, text: 'not sent: the hub bridge is off' };
  const at = sessionPlace(session);
  if (!at)
    return { ok: false, text: "not sent: hub tools work only in the host assistant's topics and the hub's groups" };
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
      log.info('hub: module started', { hostGroup: hostFolder || '(not set)', groups: [...groupFolders] });
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
  // Container agents get the hub tools only in the groups the hub serves.
  registerContainerEnv((group) => (groupFolders.has(group.folder) ? { NANOCLAW_HUB: '1' } : undefined));
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
