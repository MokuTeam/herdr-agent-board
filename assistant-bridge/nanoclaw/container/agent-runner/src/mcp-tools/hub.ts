/**
 * Hub tools: hub_send, hub_inbox (the assistant bridge, agent-board #384, phase 1).
 *
 * Registered only when NANOCLAW_HUB=1 is in the environment: the host's hub module sets it when
 * the bridge is configured, and host-runtime agents inherit it. Without it this module registers
 * nothing and the tool list is what it was.
 *
 * Each call writes a `hub_request` system row to outbound.db and waits for the host's
 * `hub_response` row in inbound.db, the way ncl's cli_request does. The host decides which topic
 * the call comes from by the session, never by the arguments.
 */
import { getOutboundDb, openInboundDb } from '../db/connection.js';
import { markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/** The host waits up to 15 s for the bridge; this leaves room for the delivery poll on both sides. */
const WAIT_MS = 30_000;
const POLL_MS = 500;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function line(text: string, isError: boolean) {
  return { content: [{ type: 'text' as const, text }], ...(isError && { isError: true }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The host's answer to one request, once it is there and nobody took it yet. */
function findResponse(requestId: string): { id: string; content: string } | undefined {
  const inbound = openInboundDb();
  try {
    const row = inbound
      .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND kind = 'system' AND content LIKE ?")
      .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null | undefined;
    if (!row) return undefined;
    const acked = getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(row.id);
    return acked ? undefined : row;
  } finally {
    inbound.close();
  }
}

async function request(op: 'send' | 'inbox', args: Record<string, unknown>) {
  const requestId = generateId();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'hub_request', requestId, op, args }),
  });
  log(`hub_${op}: ${requestId}`);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const row = findResponse(requestId);
    if (row) {
      markCompleted([row.id]);
      try {
        const parsed = JSON.parse(row.content) as { ok?: unknown; text?: unknown };
        const text = typeof parsed.text === 'string' ? parsed.text : 'the hub gave no answer';
        return line(text, parsed.ok !== true);
      } catch {
        return line('the hub answer could not be read', true);
      }
    }
    await sleep(POLL_MS);
  }
  return line(`no answer from the hub in ${WAIT_MS / 1000} s; look with hub_inbox before you send again`, true);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export const hubSend: McpToolDefinition = {
  tool: {
    name: 'hub_send',
    description:
      'Send a message to the team hub: an answer in a hub thread, or a new topic with a board on the hub. ' +
      'Always answer a hub message with this tool, never with send_message. Without thread and to, it answers ' +
      'the hub thread that brought the newest hub message here. With to and title it opens a new topic with that ' +
      "board; the board's answers come back to this topic.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'The hub thread to answer, as the hub message header names it (e.g. 1a2b3c4d or general:anna)',
        },
        to: {
          type: 'string',
          description: "A board's name on the hub, for a new topic (with title) or its general thread",
        },
        title: { type: 'string', description: 'Title of a new topic (1 to 80 characters), with to' },
        text: { type: 'string', description: 'The message, up to 4000 characters. No secrets.' },
        replyTo: { type: 'string', description: 'The msg ref from a hub header, to answer that message in particular' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = str(args.text);
    if (!text) return line('text is required', true);
    const out: Record<string, unknown> = { text };
    for (const k of ['thread', 'to', 'title', 'replyTo']) {
      const v = str(args[k]);
      if (v) out[k] = v;
    }
    return request('send', out);
  },
};

export const hubInbox: McpToolDefinition = {
  tool: {
    name: 'hub_inbox',
    description:
      'Read the hub messages waiting for this topic (the ones that did not wake you), oldest first, and mark them ' +
      'read. Short by default; full=true returns everything and is meant for a subagent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: { type: 'string', description: 'Only this hub thread' },
        full: { type: 'boolean', description: 'Everything, not cut short' },
      },
    },
  },
  async handler(args) {
    const out: Record<string, unknown> = {};
    const thread = str(args.thread);
    if (thread) out.thread = thread;
    if (args.full === true) out.full = true;
    return request('inbox', out);
  },
};

if (process.env.NANOCLAW_HUB === '1') registerTools([hubSend, hubInbox]);
