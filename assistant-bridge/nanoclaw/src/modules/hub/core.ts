/**
 * Hub module, the part with no NanoClaw imports (agent-board #384, design 3.1 and 6).
 *
 * Talks to the assistant bridge over its unix socket (protocol.ts) and turns the bridge's frames
 * into rows in NanoClaw's sessions through an injected `HubHost`, so the logic can be tested
 * without NanoClaw. index.ts binds it to the real session manager, container runner and Telegram
 * adapter.
 *
 * Every `deliver`, `schedule` and `notice` is confirmed only after it was done. A frame that fails
 * drops the connection; on the next hello the bridge sends again whatever is unconfirmed, and a row
 * id that is already there counts as done.
 */
import { connect, type Socket } from 'node:net';

import {
  BRIDGE_PROTOCOL,
  type BridgeFrame,
  encodeFrame,
  type InboxArgs,
  type Location,
  type ModuleFrame,
  parseBridgeFrame,
  parseModuleFrame,
  type SendArgs,
  takeLines,
  type Topic,
} from './protocol.js';

/** What writing a row came to: a new row, a row with that id already there, or no such place. */
export type WriteOutcome = 'written' | 'exists' | 'unknown';

export interface HubRow {
  id: string;
  text: string;
  trigger: 0 | 1;
  /** ISO time the row becomes due; absent for now. */
  processAfter?: string;
}

/** NanoClaw, as the module needs it. */
export interface HubHost {
  /** The host assistant's topics, said in the hello. */
  topics(): Topic[];
  /** Writes one inbound row into the location's session (made when it has none yet). */
  write(at: Location, row: HubRow): WriteOutcome | Promise<WriteOutcome>;
  /** Wakes the location's session. */
  wake(at: Location): void | Promise<void>;
  /** Sends a line as the bot into the location's Telegram topic. Throws when it could not. */
  notify(at: Location, text: string): Promise<void>;
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CoreOptions {
  /** The bridge's socket; absent or empty, nothing starts. */
  socketPath: string | null | undefined;
  host: HubHost;
  /** Opens the socket (tests); node:net's connect otherwise. */
  dial?: (path: string) => Socket;
  timers?: Timers;
  /** How long a tool call waits for the bridge, connecting included. */
  callTimeoutMs?: number;
  /** The wait before reconnect attempt n (1, 2, ...). */
  backoffMs?: (attempt: number) => number;
}

export interface CallAnswer {
  ok: boolean;
  text: string;
}

export interface HubCore {
  call(from: Location, op: 'send' | 'inbox', args: SendArgs | InboxArgs): Promise<CallAnswer>;
  /** Whether the bridge has said welcome on the current connection. */
  connected(): boolean;
  stop(): void;
}

export const CALL_TIMEOUT_MS = 15_000;
/** Notice ids remembered, so a notice the bridge sends again is not posted twice. */
const NOTICE_MEMORY = 500;

/** 1 s doubling up to 30 s. */
export const defaultBackoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Connects to the bridge and keeps connecting; null when there is no socket path (the module is off). */
export function startHubCore(opts: CoreOptions): HubCore | null {
  const path = opts.socketPath;
  if (!path) return null;
  const host = opts.host;
  const timers = opts.timers ?? realTimers;
  const dial = opts.dial ?? ((p: string) => connect(p));
  const callMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const backoff = opts.backoffMs ?? defaultBackoffMs;

  let socket: Socket | null = null;
  let ready = false;
  let stopped = false;
  let attempt = 0;
  let buffer = '';
  let retry: unknown;
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;
  const pending = new Map<string, { resolve: (a: CallAnswer) => void; timer: unknown }>();
  const readyWaiters = new Set<(ok: boolean) => void>();
  const notices: string[] = [];

  function send(f: ModuleFrame): boolean {
    if (!socket || socket.destroyed) return false;
    socket.write(encodeFrame(f));
    return true;
  }

  function failPending(text: string): void {
    for (const [req, p] of pending) {
      timers.clearTimeout(p.timer);
      pending.delete(req);
      p.resolve({ ok: false, text });
    }
  }

  function scheduleReconnect(): void {
    if (stopped || retry !== undefined) return;
    attempt++;
    retry = timers.setTimeout(open, backoff(attempt));
  }

  /** Lets go of a connection: once, whoever notices first (an error, a close, a frame that failed). */
  function drop(s: Socket, why: string): void {
    if (socket !== s) return;
    socket = null;
    ready = false;
    s.destroy();
    failPending(
      'not sure it went out: the connection to the hub bridge dropped before it answered; look with hub_inbox before you send again',
    );
    host.log('warn', `hub: bridge connection closed (${why})`);
    scheduleReconnect();
  }

  function open(): void {
    retry = undefined;
    if (stopped) return;
    buffer = '';
    let s: Socket;
    try {
      s = dial(path as string);
    } catch (err) {
      host.log('warn', 'hub: could not open the bridge socket', { err: errText(err) });
      scheduleReconnect();
      return;
    }
    socket = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      if (socket !== s) return;
      let topics: Topic[] = [];
      try {
        topics = host.topics();
      } catch (err) {
        host.log('warn', 'hub: could not list the topics', { err: errText(err) });
      }
      send({ t: 'hello', v: BRIDGE_PROTOCOL, topics });
    });
    s.on('data', (chunk: string | Buffer) => {
      if (socket !== s) return;
      const split = takeLines(buffer, String(chunk));
      if (!split) {
        drop(s, 'a line too long');
        return;
      }
      buffer = split.rest;
      for (const line of split.lines) {
        const f = parseBridgeFrame(line);
        if (!f) {
          host.log('warn', 'hub: dropped a frame from the bridge it does not read');
          continue;
        }
        chain = chain
          .then(() => handle(s, f))
          .catch((err) => {
            host.log('error', 'hub: a frame from the bridge failed', { t: f.t, err: errText(err) });
            drop(s, 'a frame failed');
          });
      }
    });
    s.on('error', (err: Error) => drop(s, err.message));
    s.on('close', () => drop(s, 'closed'));
  }

  async function handle(s: Socket, f: BridgeFrame): Promise<void> {
    if (socket !== s) return;
    switch (f.t) {
      case 'welcome': {
        if (f.v !== BRIDGE_PROTOCOL) {
          host.log('error', 'hub: the bridge speaks another protocol version', { theirs: f.v, ours: BRIDGE_PROTOCOL });
          drop(s, 'protocol version');
          return;
        }
        ready = true;
        attempt = 0;
        for (const w of readyWaiters) w(true);
        readyWaiters.clear();
        host.log('info', 'hub: connected to the bridge');
        return;
      }
      case 'deliver': {
        const outcome = await host.write(f.at, { id: f.id, text: f.text, trigger: f.trigger });
        if (outcome === 'unknown')
          host.log('warn', 'hub: no session for that place; the message is dropped', { at: f.at });
        else if (outcome === 'written' && f.trigger === 1) await host.wake(f.at);
        send({ t: 'confirm', id: f.id });
        return;
      }
      case 'schedule': {
        const outcome = await host.write(f.at, { id: f.id, text: f.text, trigger: 1, processAfter: f.when });
        if (outcome === 'unknown')
          host.log('warn', 'hub: no session for that place; the read is dropped', { at: f.at });
        send({ t: 'confirm', id: f.id });
        return;
      }
      case 'notice': {
        if (!notices.includes(f.id)) {
          await host.notify(f.at, f.text);
          notices.push(f.id);
          if (notices.length > NOTICE_MEMORY) notices.shift();
        }
        send({ t: 'confirm', id: f.id });
        return;
      }
      case 'result': {
        const p = pending.get(f.req);
        if (!p) return;
        pending.delete(f.req);
        timers.clearTimeout(p.timer);
        p.resolve({ ok: f.ok, text: f.text });
        return;
      }
    }
  }

  function waitReady(ms: number): Promise<boolean> {
    if (ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        timers.clearTimeout(timer);
        readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = timers.setTimeout(() => done(false), ms);
      readyWaiters.add(done);
    });
  }

  async function call(from: Location, op: 'send' | 'inbox', args: SendArgs | InboxArgs): Promise<CallAnswer> {
    if (stopped) return { ok: false, text: 'not sent: the hub module is stopped' };
    const req = `r${Date.now().toString(36)}-${++seq}`;
    // Held to the protocol's shape here, so a bad argument is answered at once and never reaches the bridge.
    const frame = parseModuleFrame(JSON.stringify({ t: 'call', req, from, op, args }));
    if (!frame || frame.t !== 'call')
      return { ok: false, text: 'not sent: those are not arguments the hub tools take' };
    if (!(await waitReady(callMs))) return { ok: false, text: 'not sent: the hub bridge is not connected' };
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => {
        pending.delete(req);
        resolve({
          ok: false,
          text: `no answer from the hub bridge in ${Math.round(callMs / 1000)} s; look with hub_inbox before you send again`,
        });
      }, callMs);
      pending.set(req, { resolve, timer });
      if (!send(frame)) {
        pending.delete(req);
        timers.clearTimeout(timer);
        resolve({ ok: false, text: 'not sent: the hub bridge is not connected' });
      }
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (retry !== undefined) timers.clearTimeout(retry);
    retry = undefined;
    for (const w of readyWaiters) w(false);
    readyWaiters.clear();
    failPending('not sent: the hub module stopped');
    const s = socket;
    socket = null;
    ready = false;
    s?.destroy();
  }

  open();
  return { call, connected: () => ready, stop };
}
