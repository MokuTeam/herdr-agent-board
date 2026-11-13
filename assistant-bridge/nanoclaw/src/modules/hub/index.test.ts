// The hub module's wiring into NanoClaw (src/modules/hub/index.ts): which places it serves, which
// session sits at which place, and which containers get the hub tools. The module reads its env at
// import, so the env is stubbed first and the module is imported dynamically.
import fs from 'fs';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-hub-index' };
});

// The real .env may configure the hub; this test sets its own.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

const TEST_DIR = '/tmp/nanoclaw-test-hub-index';

import { containerEnvFor } from '../../container-env.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import type { AgentGroup, Session } from '../../types.js';

type HubIndex = typeof import('./index.js');
let hub: HubIndex;
const savedHubFlag = process.env.NANOCLAW_HUB;

const now = (): string => new Date().toISOString();

const groups: Record<string, AgentGroup> = {
  host: { id: 'ag-host', name: 'Host', folder: 'host-folder', agent_provider: null, created_at: now() },
  dead: { id: 'ag-dead', name: 'Dead Internet', folder: 'dead-internet', agent_provider: null, created_at: now() },
  other: { id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() },
};

function wire(agentGroupId: string, mgId: string, platformId: string, isGroup: 0 | 1, createdAt = now()): void {
  createMessagingGroup({
    id: mgId,
    channel_type: 'telegram',
    platform_id: platformId,
    name: mgId,
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  createMessagingGroupAgent({
    id: `w-${mgId}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: createdAt,
  });
}

function session(agentGroupId: string, mgId: string, threadId: string | null): Session {
  return {
    id: `s-${agentGroupId}-${threadId ?? 'main'}`,
    agent_group_id: agentGroupId,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

beforeAll(async () => {
  vi.stubEnv('HUB_BRIDGE_SOCKET', '/tmp/nanoclaw-test-hub-index.sock');
  vi.stubEnv('HUB_BRIDGE_HOST_GROUP', 'host-folder');
  vi.stubEnv('HUB_BRIDGE_HOST_CHAT', '');
  vi.stubEnv('HUB_BRIDGE_GROUPS', ' dead-internet , host-folder,');
  hub = await import('./index.js');
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (savedHubFlag === undefined) delete process.env.NANOCLAW_HUB;
  else process.env.NANOCLAW_HUB = savedHubFlag;
});

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  for (const g of Object.values(groups)) createAgentGroup(g);
  wire('ag-host', 'mg-host', 'telegram:111', 0);
  wire('ag-dead', 'mg-dead', 'telegram:-100222', 1, '2026-01-01T00:00:00.000Z');
  wire('ag-other', 'mg-other', 'telegram:-100333', 1);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('placeOf', () => {
  it('resolves the host chat and its topics', () => {
    expect(hub.placeOf('host:telegram:111')).toMatchObject({ kind: 'host', threadId: null });
    expect(hub.placeOf('host:telegram:111:7')).toMatchObject({ kind: 'host', threadId: 'telegram:111:7' });
    expect(hub.placeOf('host:telegram:-100222:7')).toBeUndefined();
  });

  it('resolves a listed group: its main session and its own topics', () => {
    const main = hub.placeOf('group:ag-dead');
    expect(main).toMatchObject({ kind: 'group', threadId: null });
    expect(main?.chat.mg.id).toBe('mg-dead');
    expect(main?.chat.agentGroupId).toBe('ag-dead');
    expect(hub.placeOf('group:ag-dead/telegram:-100222:5')).toMatchObject({
      kind: 'group',
      threadId: 'telegram:-100222:5',
    });
  });

  it("refuses another chat's thread, the bare chat id as a topic, and groups it was not told about", () => {
    expect(hub.placeOf('group:ag-dead/telegram:-100333:5')).toBeUndefined();
    expect(hub.placeOf('group:ag-dead/telegram:-100222')).toBeUndefined();
    expect(hub.placeOf('group:ag-dead/')).toBeUndefined();
    expect(hub.placeOf('group:ag-other')).toBeUndefined();
    expect(hub.placeOf('group:ag-missing')).toBeUndefined();
    // The host is never a `group:` place, even though HUB_BRIDGE_GROUPS names its folder.
    expect(hub.placeOf('group:ag-host')).toBeUndefined();
  });

  it("takes a group's oldest Telegram wiring as its chat", () => {
    wire('ag-dead', 'mg-dead-2', 'telegram:-100444', 1, '2026-06-01T00:00:00.000Z');
    expect(hub.placeOf('group:ag-dead')?.chat.mg.id).toBe('mg-dead');
    expect(hub.placeOf('group:ag-dead/telegram:-100444:1')).toBeUndefined();
  });
});

describe('sessionPlace', () => {
  it('maps host and group sessions to their places', () => {
    expect(hub.sessionPlace(session('ag-host', 'mg-host', null))).toBe('host:telegram:111');
    expect(hub.sessionPlace(session('ag-host', 'mg-host', 'telegram:111:9'))).toBe('host:telegram:111:9');
    expect(hub.sessionPlace(session('ag-dead', 'mg-dead', null))).toBe('group:ag-dead');
    expect(hub.sessionPlace(session('ag-dead', 'mg-dead', 'telegram:-100222:5'))).toBe(
      'group:ag-dead/telegram:-100222:5',
    );
  });

  it('has no place for sessions outside the chats it serves', () => {
    expect(hub.sessionPlace(session('ag-other', 'mg-other', null))).toBeNull();
    expect(hub.sessionPlace(session('ag-host', 'mg-dead', null))).toBeNull();
    wire('ag-dead', 'mg-dead-2', 'telegram:-100444', 1, '2026-06-01T00:00:00.000Z');
    expect(hub.sessionPlace(session('ag-dead', 'mg-dead-2', null))).toBeNull();
  });
});

describe('container env', () => {
  it('gives NANOCLAW_HUB=1 only to the groups the hub serves', () => {
    expect(containerEnvFor(groups.dead)).toEqual({ NANOCLAW_HUB: '1' });
    expect(containerEnvFor(groups.other)).toEqual({});
    // The host's folder is dropped from HUB_BRIDGE_GROUPS; a host-runtime host inherits process env.
    expect(containerEnvFor(groups.host)).toEqual({});
  });

  it('sets NANOCLAW_HUB=1 in the host process', () => {
    expect(process.env.NANOCLAW_HUB).toBe('1');
  });
});
