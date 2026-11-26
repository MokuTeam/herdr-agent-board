// The web board: a small HTTP server (Bun.serve) on 127.0.0.1 that serves web/, the board's data
// and live updates (Server-Sent Events), and takes the same actions as the terminal board.
// Runs inside the terminal board's process (entrypoints/tui.ts); `bun src/entrypoints/server.ts` runs it alone.
//
// Only loopback, only the Host it was asked for, and every POST needs an X-Board header: a page
// on another site cannot send that without a CORS preflight, which this server never grants, so
// it cannot type into a session.

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { localAgyLimits } from '../adapters/agy-limits.ts'
import { listArchive } from '../adapters/archive-store.ts'
import { allCards, readCard } from '../adapters/cards.ts'
import {
  editNodes,
  editNodesAdding,
  loadConfig,
  readConfigFile,
  saveFoundProfiles,
  withConfigFile,
} from '../adapters/config-file.ts'
import { dbFile } from '../adapters/db.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { archiveCommit, archiveStamp, headCommit } from '../adapters/git.ts'
import { gitTools, masterGit } from '../adapters/git-access.ts'
import {
  handoverStageDir,
  moveShippedOldMasterState,
  readHandoverState,
  restoreLocalBackup,
  shippedStateMoved,
  writeHandoverState,
} from '../adapters/handover-store.ts'
import { snapshot, workspaceList } from '../adapters/herdr.ts'
import { hasDesktop, observe as observeComputer } from '../adapters/idle.ts'
import { isRecord } from '../adapters/json-store.ts'
import { knownFolders } from '../adapters/known-folders.ts'
import { activateNodeRelayKey, createNodeJoinStore, stageNodeRelayKey } from '../adapters/node-join-store.ts'
import {
  createDeviceStore,
  createNodeStore,
  dropRelayCredentials,
  type NodeStore,
  nodeDir,
  nodesDir,
  readLanesSeen,
  relayKeyPath,
  writeLanesSeen,
} from '../adapters/node-store.ts'
import { readNsNotifyPrefs, updateNsNotifyPrefs } from '../adapters/ns-sessions-prefs.ts'
import { createNsTokens, nsBridgeDirs } from '../adapters/ns-store-tokens.ts'
import { omarchyTheme } from '../adapters/omarchy.ts'
import { ownFileCheck } from '../adapters/own-files.ts'
import { knobMs, pace, pause } from '../adapters/pacing.ts'
import { archiveDir, cardsDir, pluginRoot, ROOT, scheduleDir, stateDir } from '../adapters/paths.ts'
import { goLater, holdsGit, pluginCommit, startGuard, touchCode } from '../adapters/plugin-update.ts'
import { fetchProbe, PROBE_TIMEOUT_MS, probeOrigin, probeOriginAt } from '../adapters/probe.ts'
import { programsOnPath } from '../adapters/process.ts'
import { inheritedProfileDir } from '../adapters/profiles.ts'
import { listEntries, watchesDir } from '../adapters/schedule-store.ts'
import { writeSink } from '../adapters/secret-sinks.ts'
import {
  adoptArchive,
  backupSettings,
  bunInstall,
  gitIn,
  readSelfUpdate,
  runInstaller,
  saveSelfUpdate,
  wakeBack,
  wakeUp,
} from '../adapters/self-update.ts'
import {
  endLogins,
  endStraySsh,
  generateKey,
  hostKeyFingerprint,
  hostKeyPinned,
  keyPath,
  knownHostsFile,
  knownHostsReady,
  publicKeyOf,
  readPidRecord,
  spawnRemote,
  spawnSsh,
  sshBin,
  sshVersion,
  writePidRecord,
} from '../adapters/ssh.ts'
import { rekeySession } from '../adapters/work-thread-store.ts'
import { connectWorkdeskEvents } from '../adapters/workdesk-events.ts'
import { nodeSlicesView, nodesAnswerForNode, withNodeDecisions, withNodeItems } from '../core/board-slices.ts'
import { NODE_PROGRAMS } from '../core/bundle.ts'
import { itemLane } from '../core/categories.ts'
import { answerText, decisionsConfig } from '../core/decisions.ts'
import { journalConfig } from '../core/journal.ts'
import { t } from '../core/lang.ts'
import {
  BOARD_SLICES_PATH,
  BULK_FIELD,
  DECISIONS_PATH,
  masterBulkBody,
  masterNodesBody,
  NODE_CLI_PATH,
  NODE_REVEAL_PATH,
  type NodeReveal,
  ownerCliOf,
  type RelayWho,
  relayDevicesPath,
  relayedDecisions,
  relayOwnerSetting,
  relayOwnerTeam,
} from '../core/master-relay.ts'
import { messageGate } from '../core/message-gate.ts'
import { isRoutableNodeAddress } from '../core/mokupilot-mode.ts'
import { masterHeldIds, withMasterDecisions } from '../core/node-decisions.ts'
import { dropMovedCards } from '../core/node-items.ts'
import { JOIN_TTL_MS } from '../core/node-join.ts'
import { pageWithNodeMaster } from '../core/node-master-page.ts'
import { keyedPath, nodePath } from '../core/node-proxy.ts'
import {
  configuredNodeAddresses,
  deviceIdFromHost,
  fillThresholds,
  isNodeOnly,
  LOCAL,
  markRevoked,
  type NodeMasterPayload,
  nodeConfig,
  nodeKey,
  nodesConfig,
  parseNodeKey,
  pickNodeMaster,
} from '../core/nodes.ts'
import { createNsStore } from '../core/ns-sessions.ts'
import { setAccountNotify } from '../core/ns-sessions-notify.ts'
import { pageWithLook } from '../core/omarchy-theme.ts'
import type { BackupPayload, CalendarPayload, TimePayload } from '../core/payload.ts'
import type { Observation } from '../core/presence.ts'
import { shownProfiles } from '../core/profiles.ts'
import { pwaPage } from '../core/pwa.ts'
import { ownerTeam } from '../core/remote.ts'
import { heldByDevice } from '../core/schedule-rules.ts'
import type { SetupFacts } from '../core/setup.ts'
import { teamConfig } from '../core/team.ts'
import { toastBody } from '../core/team-unread.ts'
import { MAX_NAME } from '../core/team-wire.ts'
import {
  boardPorts,
  forwardSpec,
  masterBoardUrl,
  publicHosts,
  sshArgs,
  tunnelConfig,
  tunnelProblems,
} from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import { watchesConfig } from '../core/watches.ts'
import { threadsConfig, verifyKeptOff } from '../core/work-threads.ts'
import { workdeskConfig } from '../core/workdesk.ts'
import { workdeskEventsConfig } from '../core/workdesk-events.ts'
import { childRunner, createHttpMcp } from '../entrypoints/mcp-http.ts'
import { type NoticeDesktop, noticeDesktop } from '../integrations/notice-toast.ts'
import { type ReminderDesktop, reminderDesktop } from '../integrations/reminder-toast.ts'
import { type TeamDesktop, teamDesktop } from '../integrations/team-toast.ts'
import { createAccess } from '../services/access.ts'
import { askArchive } from '../services/archive.ts'
import { backupView, startBackups } from '../services/backup.ts'
import { createBackupServer } from '../services/backup-server.ts'
import { createBoardEvents } from '../services/board-events.ts'
import { createCalendarSync } from '../services/calendar.ts'
import { createCalendarReminders } from '../services/calendar-reminders.ts'
import { caseItems, liveOf } from '../services/case-sessions.ts'
import { startCompactor } from '../services/compactor.ts'
import { dayWatchTick } from '../services/day-watches.ts'
import { decisionsPayload, nodeItemsDecisions } from '../services/decisions.ts'
import type { Deps } from '../services/deps.ts'
import { createHousekeeping } from '../services/housekeeping.ts'
import { createJournal } from '../services/journal.ts'
import { createLaunches } from '../services/launch/launches.ts'
import { mokupilotCheck } from '../services/mokupilot.ts'
import { createMoveIn, type MoveIn } from '../services/move-in.ts'
import { createMoveOut, type MoveOut } from '../services/move-out.ts'
import { createNodeBundle, nodeBundleDeps } from '../services/node/bundle.ts'
import { createCheckouts } from '../services/node/checkout.ts'
import { createNodeDesk } from '../services/node/desk.ts'
import { createNodeFunctions, functionsDir, type NodeFunctions } from '../services/node/fn-sync.ts'
import { createNodeGit } from '../services/node/git-access.ts'
import { createLocalRelayOps, createNodeHandover } from '../services/node/handover.ts'
import { createNodeLaunch } from '../services/node/launch.ts'
import { createNodeMasterFlags, type NodeMasterFlags } from '../services/node/master-flags.ts'
import { createMasterRelay, type MasterRelay } from '../services/node/master-relay.ts'
import { createNodeMasterSlices, type NodeMasterSlices } from '../services/node/master-slices.ts'
import { createNodePilotBridge, type NodePilotBridge } from '../services/node/pilot-bridge.ts'
import { createNodePilotCall, type NodePilotCall } from '../services/node/pilot-call.ts'
import { createRelayDial, type RelayDial } from '../services/node/relay-dial.ts'
import { createNodeSecrets } from '../services/node/secrets.ts'
import { createNodeStatus } from '../services/node/status.ts'
import { createNodeTelegram } from '../services/node/telegram.ts'
import { createNodeUpdate, type NodeUpdate } from '../services/node/update.ts'
import { createNodeUplink, type NodeUplink } from '../services/node/uplink.ts'
import { createNodeAggregate, type NodeAggregate } from '../services/nodes/aggregate.ts'
import { type BundleSync, createBundleSync } from '../services/nodes/bundle-sync.ts'
import { type ComputerSetup, createComputerSetup } from '../services/nodes/computer-setup.ts'
import {
  activateComputerRelayKey,
  claimComputerDoor,
  createRelayForwardPool,
  probeComputerDoor,
  readRelayHostKey,
} from '../services/nodes/computer-setup-io.ts'
import { createDesks } from '../services/nodes/desks.ts'
import {
  createFnSync,
  createFnSyncRunner,
  fnSyncDevices,
  linkReplica,
  localReplica,
} from '../services/nodes/fn-sync.ts'
import { createMasterHandover, type MasterHandover } from '../services/nodes/handover.ts'
import { createNodeLinks, linkTimes, type NodeLinks } from '../services/nodes/links.ts'
import { masterFlagsFor } from '../services/nodes/master-flags.ts'
import { createMasterRelayRunner, type MasterRelayRunner } from '../services/nodes/master-relay.ts'
import { moveToDevice } from '../services/nodes/move-device.ts'
import { createPilotBridgeRunner, type PilotBridgeRunner } from '../services/nodes/pilot-bridge.ts'
import { createNodePilotCalls, type NodePilotCalls } from '../services/nodes/pilot-call.ts'
import { createPlacer, type Placer } from '../services/nodes/placer.ts'
import { relayEnrolFor } from '../services/nodes/relay.ts'
import { createRelaySetup, type RelaySetup } from '../services/nodes/relay-setup.ts'
import { createRevoker, type Revoker } from '../services/nodes/revoke.ts'
import { createNodeSetup, type NodeSetup } from '../services/nodes/setup.ts'
import { createNodesTelegram } from '../services/nodes/telegram.ts'
import { createNodeUpdater, type NodeUpdater } from '../services/nodes/update.ts'
import { createUplinkRunner, type UplinkRunner } from '../services/nodes/uplink.ts'
import { createNsSessionsNotify } from '../services/ns-sessions-notify.ts'
import { tellOwnerWatchers } from '../services/owner-watch.ts'
import { createPresence } from '../services/presence.ts'
import { editProfile, installProfile, installThreadsSkill, wakeHooksInPlace } from '../services/profiles.ts'
import { createRemote } from '../services/remote.ts'
import { createRemoteAccess } from '../services/remote-access.ts'
import { startScheduler } from '../services/scheduler.ts'
import { auditBundle, giveSecret } from '../services/secrets.ts'
import { createSelfUpdate } from '../services/self-update.ts'
import { createServerSetup } from '../services/server-setup.ts'
import { createSetupChecks } from '../services/setup-check.ts'
import { sleepMany } from '../services/sleep.ts'
import { createTeamConfirm } from '../services/team-confirm.ts'
import { createTeam } from '../services/team-hub.ts'
import { createTeamNotify, type TeamNotify } from '../services/team-notify.ts'
import { createTeamRouter, noticeSchedule } from '../services/team-router.ts'
import { createTerminals, terminalOn } from '../services/terminals.ts'
import { piDayMirror } from '../services/thread-import.ts'
import {
  createProbes,
  createSupervisor,
  networkSignature,
  ownAddresses,
  PROBE_FIRST_MS,
  realClock,
  type TunnelPlan,
} from '../services/tunnel.ts'
import { createTurnResume } from '../services/turn-resume.ts'
import { createWakeControl, startWakeStart } from '../services/wake/control.ts'
import { createWorkHub, type WorkHub } from '../services/work-hub.ts'
import { keepThreadsDb, threadsPayload, withThreadsDb } from '../services/work-threads.ts'
import { createVerifier } from '../services/work-verify.ts'
import { createWorkdeskDialog } from '../services/workdesk-dialog.ts'
import { runWorkdeskEvents, workdeskEventHandlers } from '../services/workdesk-events.ts'
import { createWorkdeskWatcher } from '../services/workdesk-watcher.ts'
import { createBoardState } from './board-state.ts'
import { dispatch, json, peerOf, type Route } from './http.ts'
import { createNodeListener, type NodeListener } from './node-listener.ts'
import { createRemoteListener } from './remote.ts'
import { accessRoutes } from './routes/access.ts'
import { archiveRoutes } from './routes/archive.ts'
import { backupRoutes } from './routes/backup.ts'
import { boardRoutes } from './routes/board.ts'
import { boardEventRoutes } from './routes/board-events.ts'
import { calendarRoutes, eventReveal } from './routes/calendar.ts'
import { decisionsRoutes } from './routes/decisions.ts'
import { fsRoutes } from './routes/fs.ts'
import { housekeepingRoutes } from './routes/housekeeping.ts'
import { journalRoutes } from './routes/journal.ts'
import { launchRoutes } from './routes/launch.ts'
import { linksRoutes } from './routes/links.ts'
import { mcpRoutes } from './routes/mcp.ts'
import { mokupilotRoutes } from './routes/mokupilot.ts'
import { moveRoute } from './routes/move.ts'
import { masterRelayRoute, nodeCallRoutes, nodeDoorRoutes } from './routes/node.ts'
import { createNodeProxy, type NodeProxy } from './routes/node-proxy.ts'
import { computerSetupRoutes, handoverRoutes, nodeSetupRoutes, nodesRoutes, relaySetupRoutes } from './routes/nodes.ts'
import { nsNodeRoute, nsSessionRoutes } from './routes/ns-sessions.ts'
import { ownerServicesRoutes } from './routes/owner-services.ts'
import { pageLogRoute } from './routes/page-log.ts'
import { pilotCallRoutes } from './routes/pilot-call.ts'
import { presenceRoutes } from './routes/presence.ts'
import { remoteRoutes } from './routes/remote.ts'
import { nodeRevealAnswer, revealRoute, revealState } from './routes/reveal.ts'
import { scheduleRoute } from './routes/schedule.ts'
import { secretsRoutes } from './routes/secrets.ts'
import { selfUpdateRoutes } from './routes/self-update.ts'
import { sessionRoutes } from './routes/session.ts'
import { categoriesRoute, featureSettingsRoute, profilesRoute, settingsRoute } from './routes/settings.ts'
import { setupRoute } from './routes/setup.ts'
import { sleepRoute } from './routes/sleep.ts'
import { spendRoutes } from './routes/spend.ts'
import { staticRoute } from './routes/static.ts'
import { teamRoutes } from './routes/team.ts'
import { teamNotifyRoutes, teamReveal } from './routes/team-notify.ts'
import { terminalRoute } from './routes/terminal.ts'
import { revStream, threadOpenState, threadReveal, threadsRoutes } from './routes/threads.ts'
import { keepTimeDb, timeRoutes, timeToday } from './routes/time.ts'
import { todosRoutes } from './routes/todos.ts'
import { wakeRoutes } from './routes/wake.ts'
import { createBroadcaster } from './sse.ts'
import { adminOpOf, decoded, remoteRefusal } from './streams.ts'
import { createTunnelListener } from './tunnel.ts'
import { openProbeListener } from './tunnel-probe.ts'
import { pruneUploads, uploadRoutes } from './uploads.ts'
import { VIEWER_COPIES, viewerDirs, viewerEntries, WORKER_POLICIES } from './viewers.ts'
import { createWebBundle } from './web-bundle.ts'

const WEB = join(ROOT, 'web')
/** The plugin's version, for /api/hello. */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()

/**
 * The commit this board runs (#590), asked once: what a node's status says, what its update
 * compares with, and what a master ships and places by. Asked only with `node` or `nodes`.
 */
let running: Promise<string> | null = null
const runningCommit = (): Promise<string> => {
  running ??= pluginCommit(pluginRoot())
  return running
}
/** After a node's update the board ends this long after its answer, so the answer reaches the master first. */
const RESTART_AFTER_MS = 1000
/** How long a node's reveal waits for its master (#841): web-open.ts gives up on the node at 3 s. */
const REVEAL_UP_MS = 2500
/** A Windows node's board that came back on the commit of its update settles it once it has stayed up this long after its start (#699). */
const UPDATE_STABLE_MS = 10_000

export interface BoardServer {
  port: number
  url: string
  /** The route table, in its order (the tests check every route against the tunnel listener). */
  routes: readonly Route[]
  refresh(): Promise<void>
  close(): Promise<void>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A plan's or a run's id on the server: when (UTC) and a little chance, `20261021-100400-3f9a`. */
const setupId = (): string =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(2).toString('hex')}`

/**
 * A folder watched with a debounce. An error (a deleted folder on Windows: EPERM), unhandled,
 * would end the board: it is logged and ends the watch instead; the poll goes on.
 */
function watchFolder(dir: string, ms: number, onChange: () => void, log: Deps['log'], recursive = false) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, { recursive }, () => {
      clearTimeout(timer)
      timer = setTimeout(onChange, ms)
    })
    watcher.on('error', err => {
      log(`watch ${dir}: ${err.message}`)
      watcher?.close()
    })
  } catch {}
  return {
    close() {
      clearTimeout(timer)
      watcher?.close()
    },
  }
}

/** The board goes out for changes of Remote access at most this often (see accessChanged). */
export const ACCESS_PUBLISH_MS = 1000

/**
 * `fn` at most once every `ms`: a call in a quiet time runs it at once; the calls during the
 * window after it run it once more at the window's end, which opens another.
 */
function atMostEvery(ms: number, fn: () => void): { call(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let again = false
  const windowEnds = (): void => {
    timer = undefined
    if (!again) return
    again = false
    fn()
    timer = setTimeout(windowEnds, ms)
  }
  return {
    call() {
      if (timer) {
        again = true
        return
      }
      fn()
      timer = setTimeout(windowEnds, ms)
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
      again = false
    },
  }
}

export interface ServerOptions {
  deps: Deps
  port?: number
  /** What the setup check reads of this computer (services/setup-check.ts; tests hand in their own). */
  gather?: () => Promise<SetupFacts>
  /** Starts wake's start (entrypoints/wake-start.ts, with `--again` for Start again); tests hand in a recorder. */
  wakeStarter?: (args?: string[]) => void
  /** What presence detection asks the computer (adapters/idle.ts); tests hand in their own. */
  presenceObserve?: () => Promise<Observation>
  /** How often detection asks (30 s); tests ask sooner. */
  presenceIntervalMs?: number
  /** Whether this computer has a desktop (adapters/idle.ts hasDesktop, #788); tests say. */
  presenceDesktop?: () => boolean
  /** The MokuTab bridge data dirs that get a NetSuite store token (#860, adapters/ns-store-tokens.ts); tests hand in their own. */
  nsBridgeDirs?: () => string[]
}

/** The forms that add a device to this board (Settings → Devices), a master's alone. */
const SETUP_PATHS: ReadonlySet<string> = new Set([
  '/api/nodes/setup',
  '/api/nodes/relay/setup',
  '/api/nodes/computer/setup',
])

/** `deps.cfg` is the live config (liveConfig): call the returned refresh from its onChange. */
export async function startServer({
  deps,
  port: asked,
  gather,
  wakeStarter,
  presenceObserve,
  presenceIntervalMs,
  presenceDesktop,
  nsBridgeDirs: nsDirs,
}: ServerOptions): Promise<BoardServer> {
  const { cfg, log } = deps
  // The NetSuite session store (#860): values in this memory only; the master's, a pure node relays.
  const nsStore = createNsStore()
  // Each MokuTab bridge state dir here gets <dir>/ns-store-token (its URL on line 2 when not the
  // default), written once the board listens (below) and again when a token does not match
  // (adapters/ns-store-tokens.ts).
  const nsTokens = createNsTokens({
    dirs: nsDirs ?? (() => nsBridgeDirs(homedir())),
    url: () => `http://127.0.0.1:${server.port ?? port}/api/ns-sessions`,
    log,
  })
  const initialNoFileCfg = readConfigFile() === null ? structuredClone(cfg) : null
  // Crash recovery (#697): recover any incomplete handover before opening SQLite DBs or services.
  const bootHandover = readHandoverState()
  const oldMasterStillMaster =
    bootHandover?.role === 'old-master' && bootHandover.phase === 'committed' && nodesConfig(cfg.nodes) !== null
  let handoverFrozen =
    (bootHandover?.role === 'old-master' && bootHandover.phase === 'prepared') || oldMasterStillMaster
  if (bootHandover?.role === 'new-master' && (bootHandover.phase === 'prepared' || bootHandover.phase === 'applied')) {
    try {
      await restoreLocalBackup(bootHandover.id, { scope: 'all' })
      rmSync(handoverStageDir(bootHandover.id), { recursive: true, force: true })
      writeHandoverState({ ...bootHandover, phase: 'rolled-back', at: Date.now() })
      const recoveredCfg =
        initialNoFileCfg && readConfigFile() === null ? structuredClone(initialNoFileCfg) : loadConfig()
      if (asked === undefined && cfg.port !== undefined && !Object.hasOwn(readConfigFile() ?? {}, 'port')) {
        ;(recoveredCfg as unknown as Record<string, unknown>).port = cfg.port
      }
      for (const k of Object.keys(cfg)) delete (cfg as unknown as Record<string, unknown>)[k]
      Object.assign(cfg, recoveredCfg)
      log(`handover ${bootHandover.id}: recovered crashed incomplete target handover back to node`)
    } catch (err) {
      log(`handover ${bootHandover.id}: boot recovery failed: ${messageOf(err)}`)
    }
  } else if (bootHandover?.role === 'new-master' && bootHandover.phase === 'committed') {
    const rawOnDisk = readConfigFile()
    if (rawOnDisk && Object.hasOwn(rawOnDisk, 'node')) {
      withConfigFile((current, save) => {
        if (!current || !Object.hasOwn(current, 'node')) return
        const next = { ...current }
        delete next.node
        save(next)
      })
      delete (cfg as unknown as Record<string, unknown>).node
      log(`handover ${bootHandover.id}: completed deferred node-door removal after commit`)
    }
  } else if (bootHandover?.role === 'old-master' && bootHandover.phase === 'committed' && isNodeOnly(cfg)) {
    // A node its handover demoted before #777 still holds the master's state live: moved aside once,
    // before any database opens (a rollback still puts it back), and its stale backup target dropped.
    try {
      if (!shippedStateMoved(bootHandover.id)) {
        const moved = moveShippedOldMasterState(bootHandover.id, log)
        log(`handover ${bootHandover.id}: moved ${moved} files the new master took over aside`)
      }
    } catch (err) {
      log(`handover ${bootHandover.id}: moving the shipped state aside failed: ${messageOf(err)}`)
    }
    if (Object.hasOwn(readConfigFile() ?? {}, 'backup')) {
      withConfigFile((current, save) => {
        if (!current || !Object.hasOwn(current, 'backup')) return
        const next = { ...current }
        delete next.backup
        save(next)
      })
      delete (cfg as unknown as Record<string, unknown>).backup
      log(`handover ${bootHandover.id}: dropped the backup target the new master took over`)
    }
  } else if (oldMasterStillMaster) {
    log(`handover ${bootHandover?.id}: old master committed before finishing demotion; staying write-frozen`)
  } else if (handoverFrozen) {
    log(`handover ${bootHandover?.id}: old master stays frozen until rolled back`)
  }
  // Validate before starting a scheduler or changing any state.
  const cards = cardsDir()
  const port = asked ?? Number(cfg.port ?? 12422)
  pruneUploads(Number(cfg.keepUploadsDays ?? 14))
  // The profile folders found on this computer that config.json does not list yet go into it,
  // hidden, but for the default one and the one this board's own env points to.
  try {
    saveFoundProfiles(inheritedProfileDir())
  } catch (err) {
    log(`profiles: ${messageOf(err)}`)
  }
  // The React page (web/src/main.tsx) is bundled in memory (Bun.build) and served as /app.js, with
  // what it runs before it paints (web/src/theme.ts) as /theme.js; their version, with the page's
  // other files, tells open pages to reload. The quick look's viewers are bundled apart, for the
  // page to import when it opens such a file (server/viewers.ts).
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(WEB, 'src', 'main.tsx'),
    early: join(WEB, 'src', 'theme.ts'),
    viewers: viewerEntries(WEB),
    copies: VIEWER_COPIES,
    log,
  })
  const viewerExtras = { dirs: viewerDirs(ROOT), policies: WORKER_POLICIES }
  // The placer (#504): made with the links below, the first time config.json has `nodes`; until then,
  // and whenever `nodes` is off, a start runs here as it always has.
  let nodePlacer: Placer | null = null
  // Sessions started from the board (services/launch): their progress goes out with the board.
  const launches = createLaunches({
    deps,
    onChange: () => board.publish(),
    placer: () => (nodePlacer && nodesConfig(cfg.nodes) ? nodePlacer : null),
    frozen: () => handoverFrozen,
  })
  // The board's update of itself from git (#617, services/self-update.ts): checked by the schedule
  // below while config.json's `autoUpdate` is on, or asked (Settings, `board update`). A restart
  // would cut a session's start short: a launch in flight holds it.
  const selfUpdate = createSelfUpdate({
    git: (args, ms) => gitIn(pluginRoot(), args, ms),
    isCheckout: () => existsSync(join(pluginRoot(), '.git')),
    archiveCommit: () => archiveStamp(pluginRoot()),
    adoptArchive: commit => adoptArchive(pluginRoot(), commit),
    node: () => nodeConfig(cfg.node) !== null,
    config: () => cfg.autoUpdate,
    canRestart: typeof process.send === 'function',
    busy: () => {
      const n = launches.list().filter(l => l.state !== 'done' && l.state !== 'failed').length
      return n ? `${n} session start${n === 1 ? '' : 's'} in flight` : null
    },
    install: () => bunInstall(pluginRoot()),
    installer: () => runInstaller(pluginRoot()),
    backupSettings: () => backupSettings(),
    // The merge rewrote code files and one more is touched: run.ts restarts the board and
    // wake-run.ts wake, as on any code change. A board whose run.ts did not answer in 10 s restarts
    // itself as a node's update does (quit(75)).
    restart: () => {
      touchCode(pluginRoot())
      setTimeout(() => {
        process.emit('message', 'restart', undefined)
        setTimeout(() => process.exit(75), RESTART_AFTER_MS)
      }, 10_000).unref?.()
    },
    wakeUp,
    wakeBack: since => wakeBack(since),
    load: () => readSelfUpdate(),
    save: s => saveSelfUpdate(s),
    log,
    now: Date.now,
    changed: () => board.publish(),
  })
  // The terminal (services/terminals.ts): shells the board opened in sessions' folders, and live panes.
  const terminals = createTerminals({ onChange: () => board.publish() })
  // What of the board is not set up on this computer, for the page's quiet note.
  const setup = createSetupChecks({ deps, onChange: () => board.publish(), ...(gather && { gather }) })
  // Whether MokuPilot is here for calls with a fork of a session: looked up again when its
  // setting changes, and once a minute for one installed or removed meanwhile.
  const mokupilot = mokupilotCheck(cfg)
  // Side questions to a session go as Claude Code's /btw in its pane: nothing to look up here.
  const aside = () => true
  // A notification click asks for a session: pages that connect right after are told it too.
  const reveals = revealState()
  // A reminder's Open on the desktop asks for a calendar event the same way (#335).
  const eventsShown = eventReveal()
  // A team notification's click asks for a thread the same way (#355).
  const teamShown = teamReveal()
  // `board thread open` asks for a thread the same way (#392).
  const threadShown = threadOpenState()
  // The ping keeps a quiet stream open, and tells a master's link a node is there (#499): every
  // 20 s, sooner only in a test that sets BOARD_EVENTS_PING_MS (adapters/pacing.ts).
  const events = createBroadcaster(() => board.payload(), {
    pingMs: knobMs('BOARD_EVENTS_PING_MS', 20_000),
    greet: () => reveals.greet() + eventsShown.greet() + teamShown.greet() + threadShown.greet(),
  })
  // GET /api/threads/events (#392): its own stream, made on its first client. The routes use the
  // connection the payload keeps.
  const threadRevs = revStream()
  keepThreadsDb(true)
  // The remote mode (core/remote.ts): pairing, and the listener on the Tailscale address while it
  // is on. Off, it reads the config and nothing else.
  const remote = createRemote({ onChange: () => board.publish() })
  // Sleep and wake (#119): its state line, the panel's switches, and starting wake when it is on but
  // not running. Off, with no wake file, it asks nothing and starts nothing.
  const wake = createWakeControl({
    cfg,
    starter: wakeStarter ?? startWakeStart,
    asleep: () => board.items().filter(i => i.sleeping).length,
    hooks: () =>
      shownProfiles(deps.profiles().list).map(p => ({ id: p.id, title: p.title, state: wakeHooksInPlace(p.dir) })),
    onChange: () => board.publish(),
    // "Setup incomplete" follows wake's state (held, not running, running) at once, not at the next
    // check in up to 10 minutes.
    onState: () => void setup.again().catch(err => log(`setup check: ${messageOf(err)}`)),
    log,
  })
  const routes: Route[] = []
  const guards = { port, token: FILE_TOKEN, stale: () => board.stale() }
  // Omarchy here: the Terminal style takes the colors of its theme on now, and follows a switch.
  const omarchy = omarchyTheme(() => board.publish())
  // The page as config.json's `look` and Omarchy have it (core/omarchy-theme.ts); else as it is.
  const page = (html: string): string => pageWithLook(html, { look: cfg.look, omarchy: !!omarchy })
  // The page for a phone's browser through `tailscale serve`, while remote.pwa is on, and through
  // the owner's domain: marked remote, with what installs it.
  const remotePage = staticRoute(WEB, bundle, html => pwaPage(page(html), bundle.version()), viewerExtras)
  // Headless master admin (#694): resolved lazily once board, localNodeRoutes and localSetupRoutes
  // are set up below (never called before start() wires routes and begins listening).
  const remoteAdminRoutes = (path: string): Route[] | null =>
    path === '/api/nodes' && localNodeRoutes
      ? localNodeRoutes
      : path === '/api/nodes/setup' && !isNodeOnly(cfg)
        ? localSetupRoutes
        : null
  const listener = createRemoteListener({
    cfg,
    webPort: port,
    version: PLUGIN_VERSION,
    routes,
    guards,
    page: remotePage,
    remote,
    log,
    frozen: () => handoverFrozen,
    onChange: () => board.publish(),
    adminRoutes: remoteAdminRoutes,
    onAdminAuditCheck: () => board.checkAdminAudit(),
    onAdminAction: entry => board.recordAdmin(entry),
  })
  // The board through the owner's domain (core/tunnel.ts): the login (services/access.ts), the
  // nonces the board's probe answers, and the tunnel listener on 127.0.0.1 while the tunnel is on
  // and the login set up. Off, it reads the config and nothing else.
  //
  // The Remote access view's revision (the payload's accessRev): a change of the login, of the
  // tunnel's status or of its settings counts one, and the board goes out again; the panel then
  // fetches the view, which never goes out with the board. Anyone on the internet can make such a
  // change (a failed sign-in is recorded): the board goes out for them at most once a window, at
  // the first change and then at the window's end with the latest revision.
  let accessRev = 0
  const accessOut = atMostEvery(ACCESS_PUBLISH_MS, () => board.publish())
  const accessChanged = (): void => {
    accessRev += 1
    accessOut.call()
  }
  const access = createAccess({
    onChange: () => {
      accessChanged()
      void tunnel.sync().then(() => supervisor.sync())
    },
    log,
  })
  let nodeLinks: NodeLinks | null = null
  let lastMasterBoardUrl = masterBoardUrl(cfg.tunnel)
  const syncMasterBoardUrl = (): void => {
    const next = masterBoardUrl(cfg.tunnel)
    if (next === lastMasterBoardUrl) return
    lastMasterBoardUrl = next
    nodeLinks?.syncBoardUrl()
  }
  const probes = createProbes()
  const tunnel = createTunnelListener({
    cfg,
    webPort: port,
    routes,
    guards,
    page: remotePage,
    access,
    probes,
    ownFiles: ownFileCheck(cfg),
    log,
    frozen: () => handoverFrozen,
    onChange: () => {
      accessChanged()
      syncMasterBoardUrl()
      void supervisor.sync()
    },
    adminRoutes: remoteAdminRoutes,
    onAdminAuditCheck: () => board.checkAdminAudit(),
    onAdminAction: entry => board.recordAdmin(entry),
  })
  // The tunnel's ssh (services/tunnel.ts). It starts nothing until this board holds the web port
  // (below). Its line goes to the tunnel listener's port while that listens, the tunnel is on and
  // the settings check out: checked here too, since the listener follows a config change a moment
  // later, and a hand edit that fails its checks must never reach ssh meanwhile.
  const tunnelConf = () => tunnelConfig(cfg.tunnel)
  const lineTo = (target: number): TunnelPlan | null => {
    const conf = tunnelConf()
    if (tunnelProblems(conf, boardPorts(cfg.remote, port)).length) return null
    return {
      conf,
      // No ssh found: this one fails to start, which shows as noSsh.
      bin: sshBin() ?? 'ssh',
      args: sshArgs({ conf, key: keyPath(conf), knownHosts: knownHostsFile(), target }),
      forward: forwardSpec(conf.socket, target),
    }
  }
  const supervisor = createSupervisor({
    plan: () => {
      if (handoverFrozen) return null
      const at = tunnel.listening()
      return at !== null && tunnelConf().on ? lineTo(at) : null
    },
    spawn: spawnSsh,
    stray: { read: readPidRecord, write: writePidRecord, end: endStraySsh },
    clock: realClock,
    network: networkSignature,
    probes,
    // with a port, a Test that finds the public port ("Do it myself"): sent with the Host the
    // tunnel listener takes now, whichever port it came through
    probe: (nonce, port) =>
      port === undefined
        ? fetchProbe(probeOrigin(tunnelConf()), nonce)
        : fetchProbe(probeOriginAt(tunnelConf(), port), nonce, PROBE_TIMEOUT_MS, publicHosts(tunnelConf())[0]),
    // Test's own line, whether the tunnel is on or not.
    testPlan: lineTo,
    checkKey: () => publicKeyOf(keyPath(tunnelConf())),
    sshFound: () => sshBin(),
    openProbeListener,
    // a test's paced board (adapters/pacing.ts) probes sooner
    probeFirstMs: PROBE_FIRST_MS * pace(),
    onChange: accessChanged,
    log,
  })
  // Setting up the server's web server through the owner's admin connection (services/server-setup.ts):
  // the tunnel's ssh binary, host and pinned key; a test CA for the board's Caddy only when both
  // test-only variables name one.
  const acmeCa = process.env.BOARD_SETUP_ACME_CA
  const acmeRoot = process.env.BOARD_SETUP_ACME_CA_ROOT
  const serverSetup = createServerSetup({
    cfg,
    webPort: port,
    ssh: () => sshBin(),
    sshVersion,
    knownHosts: knownHostsReady,
    hostKeyPinned: () => {
      const conf = tunnelConf()
      return hostKeyPinned(conf.host, conf.sshPort)
    },
    hostKeyFingerprint: () => {
      const conf = tunnelConf()
      return hostKeyFingerprint(conf.host, conf.sshPort)
    },
    spawn: spawnRemote,
    test: () => supervisor.test(),
    onChange: accessChanged,
    log,
    now: () => Date.now(),
    newId: setupId,
    ...(acmeCa && acmeRoot && { acme: { ca: acmeCa, root: acmeRoot } }),
    // the tunnel key's public half, which Apply puts in place on the server (none before Generate key)
    publicKey: async () => {
      const r = await publicKeyOf(keyPath(tunnelConf()))
      return r.ok ? r.publicKey : null
    },
    // the panel's own On and Off, so a refusal (no login set up) is the button's
    tunnel: async on => {
      if (tunnelConf().on !== on) await remoteAccess.op({ op: on ? 'on' : 'off' })
    },
  })
  // The "Remote access…" panel's view and changes (/api/access, the local board's only).
  const remoteAccess = createRemoteAccess({
    cfg,
    webPort: port,
    access,
    supervisor,
    tunnel,
    onChange: accessChanged,
    server: serverSetup,
  })
  // A master's nodes hear of a change of the user's presence (#775); set once the relay runner is made.
  let presenceToNodes = (): void => {}
  // This computer's desk (#788): its idle time and its own notifiers, made when first used.
  const desktopHere = presenceDesktop ?? (() => hasDesktop())
  const observeHere = presenceObserve ?? (() => observeComputer())
  let ownReminders: ReminderDesktop | undefined
  let ownTeam: TeamDesktop | undefined
  let ownNotice: NoticeDesktop | undefined
  const localReminders = (): ReminderDesktop => (ownReminders ??= reminderDesktop(log))
  const localTeam = (): TeamDesktop => (ownTeam ??= teamDesktop(log))
  const localNotice = (): NoticeDesktop => (ownNotice ??= noticeDesktop(log))
  // A master's desks (#788, services/nodes/desks.ts): with `nodes` on, presence reads the most
  // recently active of its nodes' computers and its own (only where it has a desktop), and the
  // reminders and Team's notifications go to that one. Without `nodes` none of it is asked: the
  // board reads its own computer and shows its own notifications, as before.
  const desks = createDesks({
    on: () => nodesConfig(cfg.nodes) !== null,
    links: () => nodeLinks,
    deviceIds: () => Object.keys(nodesConfig(cfg.nodes)?.devices ?? {}).filter(id => id !== LOCAL),
    ownerAllowed(id) {
      const d = nodesConfig(cfg.nodes, hostname())?.devices[id]
      return !!d && !d.revoked && d.owner !== false && id !== LOCAL
    },
    desktopHere,
    observeHere,
    local: { reminder: localReminders, team: localTeam, notice: localNotice },
    log,
  })
  // The user's presence (#172): nothing is read, asked or shown while config.json has no `presence`.
  const presence = createPresence({
    cfg,
    log,
    observe: () => (desks.on() ? desks.observe() : observeHere()),
    ...(presenceIntervalMs && { intervalMs: presenceIntervalMs }),
    onChange: () => {
      board.publish()
      // A master tells its nodes (#775): their sessions hear the user's presence from it.
      presenceToNodes()
    },
    sessions: () => board.items().map(i => i.key),
  })
  // The away journal (#489): nothing is opened, read or shown while config.json has no `journal`.
  const journal = createJournal({
    cfg,
    log,
    presence: () => presence.view(),
    viewers: () => events.size(),
    onChange: () => board.publish(),
  })
  // Continue mid-turn Claude sessions after a restart (#633): on by default, off when `turnResume` is false.
  const turnResume = createTurnResume({ cfg, log })
  // The peer network (#231): no socket, timer or file while config.json has no valid `team`.
  // What comes in goes to the router (#216), which tells a session only when the owner turned
  // Agents on for that peer, and only through the schedule, with a notice of its own words.
  // Its notifications and unread count (#355) are made the first time a message comes in or the
  // payload asks while `team` is on: off, nothing of them runs.
  let teamNotify: TeamNotify | null = null
  const notifyOf = (): TeamNotify =>
    (teamNotify ??= createTeamNotify({
      desktop: { show: toast => (desks.on() ? desks.team : localTeam()).show(toast) },
      // The service's own name for a peer (roster, pins, the key's start), one line, cut.
      nameOf: peer => toastBody(team.nameOf(peer), MAX_NAME),
    }))
  // Shared threads (#394): a topic that carries a status, while threads (with `share`) and Team are
  // on. Off, its hooks answer no and the hub client says and takes nothing of them.
  let workHub: WorkHub | null = null
  const team = createTeam({
    cfg,
    log,
    version: PLUGIN_VERSION || 'dev',
    onChange: () => {
      teamNotify?.changed()
      board.publish()
      directorySoon()
      // What waits for the hub goes once it is there; drafts and history files are followed up.
      if (workHub?.on()) void workHub.flush()
    },
    work: {
      on: () => workHub?.on() ?? false,
      mayTake: m => workHub?.mayTake(m) ?? false,
      fresh: w => workHub?.fresh(w) ?? w,
    },
    // Each hearer on its own: one that throws keeps neither the other nor the message's ack back.
    onInbound: e => {
      // An entry of a shared thread tells the thread's watchers (#394); the topic's notice would say it twice.
      let taken = false
      try {
        taken = workHub?.inbound(e) ?? false
      } catch (err) {
        log(`threads: a shared entry failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        if (!taken) teamRouter.inbound(e)
      } catch (err) {
        log(`team: the router failed on a message: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        notifyOf().inbound(e)
      } catch (err) {
        log(`team: a notification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      board.publish()
    },
    onReaction: e => {
      try {
        notifyOf().reaction?.(e)
      } catch (err) {
        log(`team: a reaction notification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
  // The master's devices in the payload (#500): made with the links below, the first time
  // config.json has `nodes`; until then the board's payload is what it was without them.
  let nodeAggregate: NodeAggregate | null = null
  const teamRouter = createTeamRouter({
    team,
    cfg,
    items: () => (nodeAggregate ? [...board.items(), ...(nodeAggregate.part()?.items ?? [])] : board.items()),
    schedule: noticeSchedule,
    log,
  })
  // The peers' agent directories (#832) follow the team's news (a peer came online, the hub took
  // one) shortly after, and the board's sessions once a minute (one archived reaches nobody now).
  // A board that never exposed an agent reads two small files and sends nothing.
  let directoryTimer: ReturnType<typeof setTimeout> | null = null
  function directorySoon(): void {
    if (directoryTimer || !team.view()) return
    directoryTimer = setTimeout(() => {
      directoryTimer = null
      void teamRouter
        .syncDirectory()
        .catch(err => log(`team: directory: ${err instanceof Error ? err.message : String(err)}`))
    }, 1500)
    directoryTimer.unref?.()
  }
  const directoryTick = setInterval(directorySoon, 60_000)
  workHub = createWorkHub({
    cfg,
    team,
    router: teamRouter,
    gated: () => teamConfirm.required(),
    log,
    changed: () => board.publish(),
  })
  const work = workHub
  // The head's count: read again whenever the team changed (a message, a trim, a trust).
  let unreadRev: number | null = null
  const teamUnread = (): number | null => {
    const rev = team.rev()
    if (rev === null) return null
    const n = notifyOf()
    if (rev !== unreadRev) {
      unreadRev = rev
      n.changed()
    }
    // The count reads (and the first time writes) team-reads.json: a file that fails is no count,
    // never a payload that fails.
    try {
      return n.unread()
    } catch (err) {
      log(`team: the unread count failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  // The owner's passkey for Send, trust and widening agents (#224): confirmed in a window on
  // http://localhost:<port>, the port this board listens on.
  // What the owner's phone asks waits here (#377): the head's count follows it, out of the payload's
  // build (which reads the list) so a publish never runs inside another.
  const teamConfirm = createTeamConfirm({
    port: () => Number(server?.port ?? port),
    safe: () => !loopbackTaken,
    changed: () =>
      queueMicrotask(() => {
        try {
          board.publish()
        } catch (err) {
          log(`team: publishing what waits for the passkey failed: ${messageOf(err)}`)
        }
      }),
  })
  /** The actions asked from away that wait for the passkey here (#377); null while there are none, or no team. */
  const teamWaiting = (): number | null => {
    if (team.rev() === null) return null
    const n = teamConfirm.waiting().length
    return n > 0 ? n : null
  }
  // The confirmation window is on http://localhost:<port>, and a browser may try [::1] for
  // `localhost` before 127.0.0.1. While team is on the board holds [::1]:<port> as well, so no other
  // program can stand there and show a window of its own; if one already does, confirmations are
  // refused (teamConfirm.safe) until it is gone. Opening an owner-service confirmation also holds it.
  let loopback6: ReturnType<typeof Bun.serve> | null = null
  let loopbackTaken = false
  let ownerConfirmationOpen = false
  function holdLoopback6(): void {
    const on = teamConfig(cfg.team) !== null || ownerConfirmationOpen
    if (!on) {
      void loopback6?.stop(true)
      loopback6 = null
      loopbackTaken = false
      return
    }
    if (loopback6) return
    try {
      loopback6 = Bun.serve({
        port: Number(server.port),
        hostname: '::1',
        idleTimeout: 0,
        development: false,
        reusePort: false,
        fetch: answer,
      })
      loopbackTaken = false
    } catch (err) {
      // No IPv6 loopback on this computer: no browser reaches it either.
      const taken = (err as { code?: string }).code === 'EADDRINUSE'
      if (taken && !loopbackTaken)
        log(`[::1]:${server.port} is held by another program: passkey confirmations wait until it is gone`)
      loopbackTaken = taken
    }
  }
  // The backup of the board's database (#233): its schedule (a look a minute, which only stats the
  // file while there is none), the server's setup, and its line in the payload (none while there
  // is no database and no target).
  // config.json's `backup` as it is now: the live config follows a change a moment later, and Back
  // up now, a Look or an Apply right after the panel saved a target must already see it. Read only
  // once there is a database (the schedule) or when the panel asks.
  const backupCfg = (): Config => ({ ...cfg, backup: loadConfig().backup })
  // one connection to the database for the board's life: the payload and the Time panel's reads and writes
  keepTimeDb(true)
  // A node's database is the master's old one (#777): no schedule, no line, and the panel says so.
  const backups = startBackups({ cfg: backupCfg, onChange: () => board.publish(), onNode: () => isNodeOnly(cfg) })
  if (handoverFrozen) backups.pause()
  const backupServer = createBackupServer({ cfg: backupCfg, spawn: spawnRemote })
  const backupLine = (): BackupPayload | null => {
    if (!existsSync(dbFile()) && !cfg.backup) return null
    if (isNodeOnly(cfg)) return null
    const v = backupView(cfg)
    let last: number | null = null
    for (const s of Object.values(v.states)) if (s?.lastOk && (last === null || s.lastOk > last)) last = s.lastOk
    const first = v.problems[0]
    return { last, problem: first ? { kind: first.kind, ...('target' in first && { target: first.target }) } : null }
  }
  // Time tracking (#233): while config.json turns it on, today's billed time by lane and the
  // journal's last seq, read from the database (one query a refresh); off, nothing is read.
  const timeLine = (): TimePayload | null => timeToday(cfg)
  // The calendar (#328): while config.json turns it on, each source fetched on its own interval and
  // the payload's line (its revision, the next call); off, no timer and nothing read.
  const calendar = createCalendarSync({
    cfg,
    log,
    onChange: () => {
      reminders.changed()
      board.publish()
    },
  })
  // Its reminders (#335): while the calendar and its reminders are on, one timer for the next one
  // due, the desktop's notification and the payload's reminders on show; off, no timer.
  const reminders = createCalendarReminders({
    cfg,
    log,
    onChange: () => board.publish(),
    desktop: {
      show: toast => (desks.on() ? desks.reminder : localReminders()).show(toast),
      clear: id => (desks.on() ? desks.reminder : localReminders()).clear(id),
    },
  })
  // The line's revision moves with every copy written and every board event changed, an agent's
  // `board cal push` or `add` too: the reminders look again then.
  let calendarRev = ''
  const calendarLine = (): CalendarPayload | null => {
    const line = calendar.line()
    if (line && line.rev !== calendarRev) {
      calendarRev = line.rev
      reminders.changed()
    }
    const shown = line && reminders.line()
    return shown ? { ...line, reminders: shown } : line
  }
  const boardEvents = createBoardEvents(deps)
  const localEventRoutes = boardEventRoutes(boardEvents)
  const streamDriven = () => workdeskEventsConfig(cfg.workdesk) !== null
  let workdeskStream: { controller: AbortController; task: Promise<void> } | undefined
  let workdeskStreamConfig = ''
  async function configureWorkdeskStream() {
    const signature = JSON.stringify([cfg.workdesk, cfg.workdeskDialog])
    if (signature === workdeskStreamConfig) return
    workdeskStreamConfig = signature
    const prior = workdeskStream
    prior?.controller.abort()
    await prior?.task
    if (signature !== workdeskStreamConfig || workdeskStream !== prior) return
    workdeskStream = undefined
    const config = workdeskEventsConfig(cfg.workdesk)
    if (!config) return
    const watch = workdeskConfig(cfg.workdesk)
    if (!watch) return
    const controller = new AbortController()
    const source = boardEvents.source(
      JSON.stringify([config.url, watch.onlyTaskId, config.cursorEpoch]),
      watch.onlyTaskId,
    )
    let offline = false
    const task = runWorkdeskEvents({
      signal: controller.signal,
      cursor: source,
      connect: (since, signal) => connectWorkdeskEvents(config, since, signal),
      connectionHealthy(ok) {
        boardEvents.health('workdesk.events', ok)
        if (!ok && !offline) log('Workdesk SSE unavailable; using fallback')
        offline = !ok
      },
      ...workdeskEventHandlers(workdesk, workdeskDialog, watch.onlyTaskId),
    }).catch(() => {
      if (!controller.signal.aborted) log('Workdesk SSE consumer stopped')
    })
    workdeskStream = { controller, task }
  }
  const workdesk = createWorkdeskWatcher({
    cfg,
    items: () => (board.stale() ? null : board.items()),
    nodeItems: () => {
      const part = nodeAggregate?.part()
      if (!part) return []
      const connected = new Set(part.devices.filter(device => device.link?.state === 'online').map(device => device.id))
      return part.items.filter(item => item.device && connected.has(item.device))
    },
    observation: () => board.observation(),
    streamDriven,
    stageTracking: boardEvents.enabled,
    stages: rows => boardEvents.stages(rows),
    onChange: () => board.publish(),
    log,
  })
  const workdeskDialog = createWorkdeskDialog({
    cfg,
    items: () => board.observation()?.items ?? null,
    streamDriven,
    onChange: () => board.publish(),
  })
  // A session moved to or from another device (#616): this board's two halves, made the first time a
  // move needs them (on a master's move, or a node's door); a board that never moves one runs none of it.
  let moveHalves: { out: MoveOut; in: MoveIn } | null = null
  const movers = (): { out: MoveOut; in: MoveIn } =>
    (moveHalves ??= {
      out: createMoveOut({ deps, items: board.items, log }),
      in: createMoveIn({
        node: () => nodeConfig(cfg.node),
        profiles: () => deps.profiles(),
        start: (body, session) => launches.start(body, board.items(), { resume: session }),
        launch: id => launches.list().find(l => l.id === id),
        workspaces: () => workspaceList(8000),
        lanes: () => new Set([...cfg.categories.map(c => c.id), ...board.items().map(i => i.category)]),
        log,
      }),
    })
  // Declared before createBoardState so board.publish() never hits TDZ before doorFollows() runs.
  let door: NodeListener | null = null
  let doorStore: NodeStore | null = null
  // The MokuTab functions folder on this computer (#864): read by a node's door and status and by a
  // master's sync only, made the first time one of them asks.
  let ownFns: NodeFunctions | null = null
  const ownFunctions = (): NodeFunctions => (ownFns ??= createNodeFunctions({ dir: functionsDir(), log }))

  /** A pure node's master as its page shows it (#744); null on any other board. */
  function nodeMasterNow(): NodeMasterPayload | null {
    const n = nodeConfig(cfg.node)
    if (!n || nodesConfig(cfg.nodes) !== null || !door || !doorStore) return null
    try {
      return pickNodeMaster(n.id, doorStore.list(), door.connectedMasters())
    } catch {
      return null
    }
  }
  /**
   * A reveal sent up to this node's master (#841): only while the node's page goes there (the master
   * online with its board's URL, #744), so the board's window shows the master's page. Null on any
   * other board, and when the master did not answer within REVEAL_UP_MS: what waits on it (web-open.ts)
   * gives up after 3 s.
   */
  async function revealUp(what: NodeReveal): Promise<Response | null> {
    const m = nodeMasterNow()
    const relay = masterRelay
    if (!m?.online || !m.url || !relay?.online()) return null
    // Given up on, the request goes too: the relay drops its wait and tells the master (`close`).
    const gone = new AbortController()
    const req = new Request(`http://127.0.0.1${NODE_REVEAL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(what),
      signal: gone.signal,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(resolve => {
      timer = setTimeout(
        () => {
          gone.abort()
          resolve(null)
        },
        knobMs('BOARD_REVEAL_UP_MS', REVEAL_UP_MS),
      )
    })
    try {
      const sent = relay
        .relay(req, { rawPath: NODE_REVEAL_PATH, search: '', remote: false, refuse: () => null })
        .then(res => res ?? null)
      const res = await Promise.race([sent, late])
      if (!res) log(`reveal up: no answer from the master`)
      else if (!res.ok) log(`reveal up: HTTP ${res.status}`)
      return res
    } catch (err) {
      log(`reveal up: ${messageOf(err)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  /** The name of the machine this node's board is served from, for a node's one-line notes (#777); null when none is paired. */
  function masterNameHere(): string | null {
    const n = nodeConfig(cfg.node)
    if (!n || !doorStore) return null
    try {
      return pickNodeMaster(n.id, doorStore.list(), door?.connectedMasters() ?? new Set())?.name || null
    } catch {
      return null
    }
  }
  // A node's copy of its master's feature flags (#775, services/node/master-flags.ts); null without `node`.
  let nodeFlags: NodeMasterFlags | null = null
  // A node's copy of its master's payload parts (#780, services/node/master-slices.ts); null without `node`.
  let nodeSlices: NodeMasterSlices | null = null
  /** The questions this node's cards carry for its master, as masterDecisions last saw them (#784). */
  let heldForMaster = ''
  const board = createBoardState({
    deps,
    launches,
    terminals,
    version: bundle.version,
    push: payload => events.send(payload),
    setup: setup.summary,
    wake: wake.current,
    mokupilot,
    remote: listener.view,
    aside,
    accessRev: () => accessRev,
    ...(omarchy && { omarchy: omarchy.stamp }),
    presence: presence.view,
    teamRev: team.rev,
    teamUnread,
    teamWaiting,
    backup: backupLine,
    time: timeLine,
    calendar: calendarLine,
    workdesk: workdesk.view,
    workdeskDialog: workdeskDialog.view,
    observeSessions: (snapshot, items) => boardEvents.observe(snapshot, items, Date.now()),
    observeFailure: () => boardEvents.health('herdr', false),
    nodes: () => nodeAggregate,
    journal,
    turnResume,
    allowCallParent: (device, parentKey) => nodePilotCalls?.allowsCallParent(device, parentKey) ?? false,
    nodeMaster: nodeMasterNow,
    // A node's master-owned features (#775): only once its master sent them; Settings shows them as the master's.
    masterFlags: () => {
      const f = nodeConfig(cfg.node) ? nodeFlags?.current() : null
      if (!f) return null
      let name = f.master
      try {
        const n = nodeConfig(cfg.node)
        const m = n && door && doorStore ? pickNodeMaster(n.id, doorStore.list(), door.connectedMasters()) : null
        if (m?.name) name = m.name
      } catch {}
      return {
        master: name,
        at: f.at,
        on: [...f.on],
        ...(f.threads && { threads: f.threads }),
        ...(f.todos && { todos: f.todos }),
        ...(f.decisions && { decisions: f.decisions }),
        ...(f.presence && { presenceMode: f.presence.mode }),
      }
    },
    // A node's master-run parts of the payload (#780): only once its master gave them.
    // Since #786 also Team's numbers and the master's devices, rebased so this computer is `local`.
    masterSlices: () => {
      const n = nodeConfig(cfg.node)
      if (!n) return null
      const got = nodeSlices?.current() ?? null
      const view = got
        ? nodeSlicesView(got, {
            self: n.id,
            ownTeam: teamConfig(cfg.team) !== null,
            ownDevices: nodesConfig(cfg.nodes) !== null,
            online: masterRelay?.online() ?? false,
          })
        : null
      // Threads on at the master (#797): its page shows them, their routes go up the relay, also
      // before its slices came or from a master whose slices carry none (an older one).
      if (!view?.threads && nodeFlags?.current()?.on.includes('threads'))
        return { ...view, threads: { rev: 0, needsOwner: 0 } }
      return view
    },
    // Threads (#379): while config.json turns them on, the revision and the count that waits on
    // the owner (two queries a refresh); off, nothing is read.
    threads: () => {
      const line = threadsPayload(cfg)
      if (line) threadRevs.moved(line.rev)
      // An entry's way to the hub moved (#394): the page reads its thread again.
      const out = work.rev()
      return line && out ? { ...line, out } : line
    },
    // Decisions (#487): while config.json turns them on, the queue from the items and the cards; off, nothing is read.
    decisions: items => {
      const on = decisionsConfig(cfg.decisions)
      return on ? decisionsPayload(items, allCards(), { now: Date.now(), defaults: on.defaults }) : null
    },
    // A node's questions with options as its master holds them (#784): only on a node, once its
    // master gave them. A change of what its cards carry for the master asks the master again, so a
    // question just asked shows at once.
    masterDecisions: () => {
      if (!nodeSlices) return null
      const cards = allCards()
      const held = masterHeldIds(cards)
      if (held !== heldForMaster) {
        heldForMaster = held
        nodeSlices.poke()
      }
      const got = nodeSlices.current()?.decisions
      if (!got) return null
      return {
        items: list => withMasterDecisions(list, null, got, cards).items,
        queue: own => withMasterDecisions([], own, got, cards).decisions,
      }
    },
    // Nodes' cards (#781): a decision shows as this board holds it; the cards are read only for one that has any.
    nodeDecisions: items =>
      items.some(i => i.decision !== undefined)
        ? nodeItemsDecisions(items, allCards(), decisionsConfig(cfg.decisions) !== null)
        : [...items],
  })
  board.publish()
  // NetSuite session death & expiry notices (#897): fires once per session lifetime for accounts
  // without auto-renew or toggled on; zero timers while the store holds no live/dying entries.
  // Read notify prefs once and refresh in place when toggled, avoiding disk reads per store change.
  let nsNotifyPrefs = readNsNotifyPrefs()
  const nsPrefs = {
    get: () => nsNotifyPrefs,
    set: (account: string, value: boolean | null) => {
      nsNotifyPrefs = updateNsNotifyPrefs(cur => setAccountNotify(cur, account, value))
      return nsNotifyPrefs
    },
  }
  const nsNotify = createNsSessionsNotify({
    store: nsStore,
    prefs: nsPrefs.get,
    desktop: { show: toast => (desks.on() ? desks.notice : localNotice()).show(toast) },
    items: board.items,
    log,
  })
  // A pi day's task board copied into threads (#393), before each refresh: a change of pi's file is in
  // the payload's threads revision with it. Off, it returns at the config's threads key.
  const piTasks = piDayMirror({
    cfg,
    log,
    sessionOf: key => {
      const item = board.items().find(i => i.key === key || i.session === key)
      return item ? { kind: 'session', key: item.key, name: item.name || item.autoName || item.key.slice(0, 8) } : null
    },
  })
  // A MokuPilot day's watches carried to its new conversation (#403, services/day-watches.ts), then
  // `board thread watch --owner` (#434, services/owner-watch.ts): after each refresh, what waits on
  // the owner told to the sessions that watch it. Threads off: nothing; no day card and no such
  // watch: one query.
  const dayWatches = dayWatchTick()
  const ownerTick = (): void => {
    const c = threadsConfig(cfg.threads)
    if (!c) return
    try {
      const items = board.stale() ? null : board.items()
      withThreadsDb(false, db => {
        if (!db) return
        dayWatches({ db, cfg: c, items, now: Date.now(), log })
        tellOwnerWatchers({ db, cfg: c, items, now: Date.now(), log })
      })
    } catch (err) {
      log(`owner watch: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const refresh = (): void => {
    piTasks.tick()
    void board.refresh().then(ownerTick)
  }
  // After Install from the Profiles panel, and the install a show runs: the panel's note and "Setup
  // incomplete" follow at once, not at the next refresh and the next check in up to 10 minutes;
  // also when only herdr's own hook failed, after the board's went in.
  const installed = (): void => {
    board.publish()
    setup.again().catch(err => log(`setup check: ${messageOf(err)}`))
  }

  // Node housekeeping (#652): off by default (zero timers until enabled in config.json).
  const housekeeping = createHousekeeping({
    deps,
    items: board.items,
    log,
    async notifyRemote(target, text) {
      if (!nodeUplink) return
      const sender = board.items().find(i => !i.sleeping && i.session) ?? board.items()[0]
      if (!sender) return
      await nodeUplink.call({
        cmd: 'send',
        argv: [target, text],
        session: sender.key,
        lane: sender.category ?? null,
        files: [],
      })
    },
  })

  // The order of main's `if` chain: the first route that answers wins.
  routes.push(
    setupRoute(setup),
    // Which process this board is and where it is installed (#356), for the board command and
    // doctor on this computer: a server that does not answer it runs older code (core/board-port.ts).
    {
      method: 'GET',
      path: '/api/process',
      handle: () => json(200, { board: 'agent-board', pid: process.pid, root: ROOT }),
    },
    ...remoteRoutes(listener, remote, cfg, port),
    ...accessRoutes(remoteAccess),
    ...boardRoutes(board, events),
    // The edge log, every link event read from the transcripts (adapters/edge-log.ts); this computer only.
    ...linksRoutes(board),
    ...fsRoutes(),
    ...uploadRoutes(),
    revealRoute(board, events, reveals, word => threadReveal({ cfg }, events, threadShown, word), revealUp),
    settingsRoute(),
    // Settings → Watches, Decisions, Away journal (#596), on this computer only.
    featureSettingsRoute(),
    // Settings → MokuPilot…: where a call starts, here or on the viewer's computer.
    ...mokupilotRoutes(cfg),
    // The user's presence: read, switched and set (the page, the phone, the Android app).
    ...presenceRoutes(presence),
    // The NetSuite session store (#860, #897): a MokuTab bridge's; a pure node relays it to its master.
    ...nsSessionRoutes({
      store: () => (isNodeOnly(cfg) ? null : nsStore),
      tokenOk: given => nsTokens.check(given),
      prefs: nsPrefs,
      log,
    }),
    // The away journal (#489): its list and the strip's dismiss (404 while off).
    ...journalRoutes(journal, () => journalConfig(cfg.journal) !== null),
    // The peer network: roster, threads, sends (local only; nothing answers while `team` is off).
    ...teamRoutes(
      team,
      teamRouter,
      cfg,
      () => {
        teamNotify?.changed()
        board.publish()
      },
      teamConfirm,
      work,
      () => ownerConfirmationOpen,
      refresh,
    ),
    ...ownerServicesRoutes(
      teamConfirm,
      () => {
        ownerConfirmationOpen = true
        holdLoopback6()
      },
      refresh,
      () => !isNodeOnly(cfg),
    ),
    // The owner read a thread, or clicked a team notification on the desktop (#355).
    ...teamNotifyRoutes({
      notify: () => (team.rev() === null ? null : notifyOf()),
      events,
      shown: teamShown,
      changed: () => board.publish(),
    }),
    // Threads (#392): the page's, MokuPilot's and the MCP adapter's reads and the owner's writes.
    ...threadsRoutes(
      {
        cfg,
        changed: () => board.publish(),
        async tell(key, text) {
          if (parseNodeKey(key) && nodeProxy) {
            const r = await nodeProxy.send(key, text, { requestId: randomUUID(), idle: false, noWake: false })
            return r.ok ? { ok: true } : { ok: false, error: r.error }
          }
          const { t } = await import('../core/lang.ts')
          const { collect } = await import('../services/board.ts')
          const { send } = await import('../services/actions.ts')
          const item = (await collect(deps)).find(i => i.key === key)
          if (!item) return { ok: false, error: t('err.gone') }
          const r = await send(deps, item, text)
          return r.ok ? { ok: true } : { ok: false, error: String(r.error ?? '') }
        },
        async clearAsk(key, question, answer) {
          const { readCard, writeCard } = await import('../adapters/cards.ts')
          const card = readCard(key)
          if (card?.ask !== question) return
          // A decision it carried (#487) closes with it, as the owner's answer in the thread.
          if (card.decision !== undefined) {
            const { closeCardDecision, withDecisionsDb } = await import('../services/decisions.ts')
            try {
              withDecisionsDb(db =>
                closeCardDecision(
                  db,
                  key,
                  { answer: answer ? answerText(answer) : null, answeredBy: 'owner', via: 'text', at: Date.now() },
                  { by: 'owner' },
                ),
              )
            } catch {}
          }
          writeCard(key, { ask: '', askSince: '' })
        },
        work,
        confirm: teamConfirm,
        // Case files (#488): a case's sessions as the board sees them now (its items, the nodes' items
        // where it is a master with them, the archive).
        caseLive: keys => liveOf(keys, board.stale() ? null : caseItems(board.items(), nodeAggregate?.part() ?? null)),
        // Assignee's lane (#903): item's real lane, falling back to its local card when unshown.
        sessionLane: key => {
          const all = [...board.items(), ...(nodeAggregate?.part()?.items ?? [])]
          const found = all.find(i => i.key === key)
          const fromItem = itemLane(found, cfg)
          if (fromItem) return fromItem
          return !parseNodeKey(key) ? itemLane({ category: readCard(key)?.category, categorySet: true }) : null
        },
        // Settings turned them on (#410): the skill where the install action puts it.
        skill: () => installThreadsSkill(deps.profiles().list),
      },
      threadRevs,
    ),
    // Tasks (#202): points pinned on the board, done, reopened, removed; turned on or off.
    ...todosRoutes({ cfg, find: board.find, refresh }),
    // Decisions (#487): an option or the owner's words typed in, Hold, the record; the phone too.
    ...decisionsRoutes({
      cfg,
      // A node's session too (#781): its questions with options are this board's.
      find: key => board.findAny(key),
      log,
      refresh,
      changed: () => board.publish(),
      // A shared thread's answer (#394): sent now, or held for the passkey as the Threads panel's is.
      work,
      confirm: teamConfirm,
      async tell(key, text) {
        const { t } = await import('../core/lang.ts')
        // A node's session (#781): through its node, as the scheduler's delivery goes; only with `nodes`.
        if (parseNodeKey(key)) {
          if (!nodeProxy) return { ok: false, error: t('err.gone') }
          const r = await nodeProxy.send(key, text, { requestId: randomUUID(), idle: false, noWake: false })
          return r.ok ? { ok: true } : { ok: false, error: r.error }
        }
        const { collect } = await import('../services/board.ts')
        const { send } = await import('../services/actions.ts')
        const item = (await collect(deps)).find(i => i.key === key)
        if (!item) return { ok: false, error: t('err.gone') }
        const r = await send(deps, item, text)
        return r.ok ? { ok: true } : { ok: false, error: String(r.error ?? '') }
      },
    }),
    // Secret requests (#273): the owner's submit writes the sink, or the owner declines; the phone too.
    ...secretsRoutes({ refresh }),
    // Time entries by day and client, as billed (#233): read only, the remote page too.
    ...timeRoutes(cfg),
    // Token spend by lane and local day (#636): read only, the remote page too.
    ...spendRoutes({ cfg, deps, items: board.items }),
    // The calendar (#328): every source's events in a window, Sync, the board's own events; Settings → Calendar here only.
    ...calendarRoutes(cfg, calendar, { reminders, events, shown: eventsShown }),
    // Settings → Backup… (#233): the passphrase, the targets, the server's setup; this computer only.
    ...backupRoutes({
      cfg,
      server: backupServer,
      now: () => backups.now(true),
      changed: () => board.publish(),
      onNode: () => isNodeOnly(cfg),
      masterName: masterNameHere,
    }),
    // Settings → Updates… (#617): one schedule on the master, also shown on its paired nodes.
    ...selfUpdateRoutes({
      updater: selfUpdate,
      load: readSelfUpdate,
      checkout: async () => {
        if (!existsSync(join(pluginRoot(), '.git'))) return null
        const [branch, commit] = await Promise.all([
          gitIn(pluginRoot(), ['symbolic-ref', '--quiet', '--short', 'HEAD']),
          gitIn(pluginRoot(), ['rev-parse', 'HEAD']),
        ])
        return { branch: branch.ok ? branch.out.trim() : null, commit: commit.out.trim() }
      },
      node: () => nodeConfig(cfg.node) !== null,
      masterId: () => nodesConfig(cfg.nodes, hostname())?.id,
      canRestart: typeof process.send === 'function',
      changed: () => board.publish(),
    }),
    // Settings → Housekeeping… (#652): memory guard and leftover browser tab sweep; this computer only.
    ...housekeepingRoutes({ housekeeping, changed: () => board.publish() }),
    // A line from the page for this log (a phone's browser says what it could not do there).
    pageLogRoute(log),
    scheduleRoute(refresh),
    // Several sessions put to sleep at once, for agents (services/sleep.ts).
    sleepRoute({ deps, items: board.items, refresh }),
    // Sessions to another Claude profile, from the card and lane menus (services/move.ts, #256), and
    // to another device while this board is a master (#616, services/nodes/move-device.ts).
    moveRoute({
      deps,
      items: board.items,
      refresh,
      toDevice: (targets, device, how) => {
        const moveNodes = () => nodesConfig(cfg.nodes, hostname())
        const masterId = moveNodes()?.id ?? ''
        return nodeLinks && moveNodes()
          ? moveToDevice(
              {
                nodes: moveNodes,
                link: id => nodeLinks?.link(id) ?? null,
                ...movers(),
                items: () => dropMovedCards([...board.items(), ...(nodeAggregate?.part()?.items ?? [])], masterId),
                rekeyThreads: (from, to) => {
                  withThreadsDb(false, db => db?.write('board', tx => rekeySession(tx, from, to)))
                },
                log,
                startWaitMs: knobMs('BOARD_MOVE_START_WAIT_MS', 120_000),
              },
              targets,
              device,
              how,
            )
          : null
      },
    }),
    // Settings → Sleep and wake… (services/wake/control.ts), for this computer only.
    ...wakeRoutes(wake),
    // The archive: its list, and archiving, bringing back or removing sessions (services/archive.ts).
    ...archiveRoutes({ deps, launches, items: board.items, find: board.find, refresh }),
    categoriesRoute(),
    // The Profiles panel: Install, and its edits, a show installing too (services/profiles.ts).
    profilesRoute(
      async id => {
        const done = await installProfile(deps, id)
        installed()
        return done
      },
      body => editProfile(body, installed),
    ),
    ...launchRoutes(launches, board.items),
    terminalRoute({ cfg, terminals, find: board.find, publish: board.publish }),
    // Updated once `nodes` starts so MokuPilot link calls can recognize registered node viewers.
    ...sessionRoutes({
      deps,
      launches,
      find: board.find,
      items: board.items,
      refresh,
      gate: messageGate(),
      answering: new Set(),
      nodeAddresses: () => registeredNodeAddresses(),
    }),
    // The board's MCP for sessions of any agent kind (#813): each call the board command as its caller.
    ...mcpRoutes({
      ownerServicesEnabled: () => !isNodeOnly(cfg),
      mcp: createHttpMcp({
        version: PLUGIN_VERSION || 'dev',
        run: childRunner({
          root: ROOT,
          env: () => process.env,
          cwd: ROOT,
          exists: existsSync,
          workspaceOf: async pane => (await snapshot()).panes.find(p => p.pane_id === pane)?.workspace_id ?? undefined,
          serviceWorkspace: async () => {
            const workspaces = await workspaceList()
            return (workspaces.find(w => w.focused) ?? workspaces[0])?.id
          },
        }),
      }),
      find: ref => {
        const items = board.items()
        const it =
          (ref.session && items.find(i => i.key === ref.session || i.session === ref.session)) ||
          (ref.pane && items.find(i => i.pane === ref.pane)) ||
          null
        // Its Claude folder as its hooks reported it: the profile a session's own command runs in.
        const dir = readCard(it?.key ?? ref.session ?? '')?.profileDir
        const configDir = typeof dir === 'string' && isAbsolute(dir) ? dir : undefined
        if (!it && !configDir) return null
        return {
          ...(it?.pane && { pane: it.pane }),
          ...(it?.cwd && { cwd: it.cwd }),
          ...(configDir && { configDir }),
        }
      },
    }),
    // The Omarchy theme's colors for the Terminal style, on a computer with Omarchy.
    {
      method: 'GET',
      path: '/omarchy-theme.css',
      handle: () => {
        const css = omarchy?.css()
        if (!css) return json(404, { error: 'not found' })
        return new Response(css, {
          headers: {
            'content-type': 'text/css; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
    // A pure node's page carries its master (#797): a tab in the background goes to it too. Any
    // other board's page goes out as it was.
    staticRoute(WEB, bundle, html => pageWithNodeMaster(page(html), nodeMasterNow()), viewerExtras),
  )
  // The board's own routes, as they are without `nodes`: the master door serves these (a node
  // passes nothing on to nodes of its own), and the node proxy hands them a bulk request's local part.
  const ownRoutes: Route[] = [...routes]
  const host = new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`)
  const ownOrigin = (req: Request): boolean => {
    const origin = req.headers.get('origin')
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  }

  async function answer(req: Request, srv?: ReturnType<typeof Bun.serve>): Promise<Response> {
    // The header first: with an empty, invalid or missing Host, Bun's req.url is a bare path.
    if (!host.test(req.headers.get('host') ?? '')) return json(403, { error: 'host' })
    let url: URL | undefined
    try {
      url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)
      // Something done on this board's own page is the user at the computer (presence's "back");
      // the CLI and agents send no Origin, and the presence switch itself says what it says.
      if (
        handoverFrozen &&
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        path.startsWith('/api/') &&
        path !== '/api/nodes/handover'
      ) {
        return json(503, { error: 'handover-frozen', message: 'master handover in progress; writes are frozen' })
      }
      if (req.method !== 'GET' && path.startsWith('/api/') && path !== '/api/presence' && ownOrigin(req))
        presence.touch()
      // Adding a server or a computer on a node would make a second master by accident (#777): it
      // goes to the master over the relay instead (#786), as Devices does.
      if (SETUP_PATHS.has(path) && isNodeOnly(cfg)) {
        const up = masterRelayFirst
          ? await dispatch([masterRelayFirst], req, url, path, guards, () => peerOf(srv, req))
          : null
        return up ?? json(409, { ok: false, error: t('node.add.onNode') })
      }
      const selected =
        path === '/api/board-events' || path === '/api/board-events/ack'
          ? localEventRoutes
          : path === '/api/nodes' && localNodeRoutes
            ? localNodeRoutes
            : path === '/api/node/call' && localCallRoutes
              ? localCallRoutes
              : path.startsWith('/api/mokupilot/node-call/') && localPilotCallRoutes
                ? localPilotCallRoutes
                : path === '/api/nodes/telegram' && localTelegramRoutes
                  ? localTelegramRoutes
                  : path === '/api/nodes/setup'
                    ? localSetupRoutes
                    : path === '/api/nodes/relay/setup'
                      ? localRelaySetupRoutes
                      : path === '/api/nodes/computer/setup'
                        ? localComputerSetupRoutes
                        : path === '/api/nodes/handover' && hasHandoverRoute()
                          ? localHandoverRoutes
                          : routes
      return await dispatch(selected, req, url, path, guards, () => peerOf(srv, req))
    } catch (err) {
      // The path only: a query can carry the page's token.
      log(`${req.method} ${url ? url.pathname : req.url.split('?')[0]}: ${messageOf(err)}`)
      return json(500, { error: messageOf(err) })
    }
  }

  /**
   * A request a node relayed (#764, services/nodes/master-relay.ts), run against this board's routes as a
   * remote owner's would be: what stays with this computer's screen or this board alone is refused
   * (server/streams.ts remoteRefusal; threads are the owner's, #392), writes wait out a handover,
   * and the guards see a remote caller. This board's own relay route, when it is a node too, is
   * left out: what a node asks of it is answered here.
   */
  async function replayRelayed(incoming: Request, from?: { device: string; who: RelayWho }): Promise<Response> {
    let req = incoming
    let url = new URL(req.url)
    const raw = url.pathname
    const path = decoded(raw)
    if (path === null) return json(400, { error: 'path' })
    if (handoverFrozen && req.method !== 'GET' && req.method !== 'HEAD')
      return json(503, { error: 'handover-frozen', message: 'master handover in progress; writes are frozen' })
    // One of this board's own sessions, as a node's page names it beside its own (#904,
    // core/board-slices.ts itemsForNode): answered here by its own key.
    const keyed = from ? keyedPath(raw) : null
    if (keyed && keyed.device === (nodesConfig(cfg.nodes, hostname())?.id ?? '')) {
      const own = new URL(url)
      own.pathname = nodePath(keyed)
      return replayRelayed(new Request(own, req), from)
    }
    // For a node only (#780): the payload's master-run parts, and a sessionless terminal's command as the owner's.
    if (req.method === 'GET' && raw === BOARD_SLICES_PATH) {
      // The node's own page asks as the owner; a node session reads its panels by their own paths.
      if (from?.who.kind !== 'owner') return json(403, { ok: false, error: 'owner' })
      // Since #784 with the master's decisions for that node's sessions; since #904 with the other
      // machines' sessions, this board's own under its id.
      const selfId = nodesConfig(cfg.nodes, hostname())?.id ?? ''
      const slices = withNodeDecisions(board.slices(), board.decisions(), from.device)
      return json(200, { ok: true, slices: withNodeItems(slices, board.shownItems(), from.device, selfId) })
    }
    if (req.method === 'POST' && raw === NODE_CLI_PATH) {
      if (from?.who.kind !== 'owner') return json(403, { ok: false, error: 'owner' })
      const call = ownerCliOf(await req.json().catch(() => null))
      if (!call) return json(400, { ok: false, error: 'call' })
      if (!uplinkRunner) return json(503, { ok: false, error: 'uplink' })
      return json(200, await uplinkRunner.ownerCall(from.device, call))
    }
    // A notification clicked or a thread opened on a node whose page is here now (#841): this board's
    // pages show it, as for one of its own. The owner's only; what it may name: routes/reveal.ts.
    if (req.method === 'POST' && raw === NODE_REVEAL_PATH && from) {
      if (from.who.kind !== 'owner') return json(403, { ok: false, error: 'owner' })
      return nodeRevealAnswer(await req.json().catch(() => null), from.device, {
        findAny: board.findAny,
        events,
        state: reveals,
        thread: word => threadReveal({ cfg }, events, threadShown, word),
      })
    }
    // A node's page answers its own sessions' questions here (#781): their keys as this board names them.
    if (raw === DECISIONS_PATH && from) {
      const body = req.method === 'POST' ? await req.json().catch(() => null) : undefined
      const next = relayedDecisions(req.method, url, body, from.device)
      if (!next) return json(400, { ok: false, error: 'key' })
      url = next.url
      req = new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(req.method === 'POST' && { body: JSON.stringify(next.body) }),
      })
    }
    // A node's bulk request (#786): a key of this board's own loses its prefix, a move to this
    // board's own id is a move to `local`; every other machine's key goes on to the node proxy.
    if (from && req.method === 'POST' && BULK_FIELD[raw]) {
      const selfId = nodesConfig(cfg.nodes, hostname())?.id ?? ''
      const body = masterBulkBody(raw, await req.json().catch(() => null), selfId)
      req = new Request(url, { method: req.method, headers: req.headers, body: JSON.stringify(body) })
    }
    const owner = from?.who.kind === 'owner'
    // Devices and its setup forms (#786): a master's own, the owner's on each paired device (never a
    // node session's), each change in the admin log. Answered by the same routes as on this
    // computer (answer() picks them there); a board without `nodes` has none of them.
    if (from && relayDevicesPath(raw)) {
      if (!owner) return json(403, { ok: false, error: 'owner' })
      const picked =
        raw === '/api/nodes'
          ? localNodeRoutes
          : isNodeOnly(cfg)
            ? null
            : raw === '/api/nodes/setup'
              ? localSetupRoutes
              : raw === '/api/nodes/relay/setup'
                ? localRelaySetupRoutes
                : localComputerSetupRoutes
      if (!picked) return json(404, { ok: false, error: 'not found' })
      if (raw !== '/api/nodes') return replayAdmin(req, url, path, picked, from.device, req.method !== 'GET')
      // The node's page names itself `local` and this board by its id: its device ids are read
      // this board's way, and the answer goes back in its terms (core/board-slices.ts).
      const selfId = nodesConfig(cfg.nodes, hostname())?.id ?? ''
      if (req.method === 'POST') {
        const body = masterNodesBody(await req.json().catch(() => null), from.device, selfId)
        req = new Request(url, { method: req.method, headers: req.headers, body: JSON.stringify(body) })
      }
      const res = await replayAdmin(req, url, path, picked, from.device, req.method !== 'GET')
      if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res
      const answer = await res.json().catch(() => null)
      return json(res.status, nodesAnswerForNode(answer, from.device, selfId))
    }
    // The settings of the features the master runs for every machine (#780), which a remote
    // listener keeps on this computer (localOnly), are the owner's on each of its paired devices
    // too; never a node session's. What acts on this computer's screen stays refused. Each write of
    // them goes into the admin log, as an owner-admin login's does through the tunnel.
    const setting = relayOwnerSetting(req.method, raw, from?.who)
    // Team (#786): the owner's on each paired device as at the computer, but the passkey's own
    // window; a change of what agents or peers may do goes into the admin log.
    const team = owner && relayOwnerTeam(req.method, raw)
    const refused = remoteRefusal(raw, path, false, false, true, setting || team)
    if (refused) return refused
    const table = masterRelayFirst ? routes.filter(r => r !== masterRelayFirst) : routes
    const device = from?.device ?? 'unknown'
    if (team) return replayAdmin(req, url, path, table, device, req.method !== 'GET' && !ownerTeam(raw))
    return replayAdmin(req, url, path, table, device, setting && req.method !== 'GET')
  }

  /** A relayed request run against `table` as a remote caller's; with `log`, in the admin log as the owner's on `device`. */
  async function replayAdmin(
    req: Request,
    url: URL,
    path: string,
    table: Route[],
    device: string,
    log: boolean,
  ): Promise<Response> {
    if (log && !board.checkAdminAudit()) return json(503, { ok: false, error: 'audit' })
    const op = log ? await adminOpOf(req) : undefined
    let res: Response | undefined
    try {
      res = await dispatch(table, req, url, path, { ...guards, remote: true, relayFrom: device })
      return res
    } finally {
      if (log)
        board.recordAdmin({
          kind: 'admin',
          at: Date.now(),
          method: req.method,
          path: path.slice(0, 200),
          ...(op && { op }),
          status: res?.status ?? 500,
          via: 'relay',
          who: `owner on ${device}`,
          from: device,
        })
    }
  }

  // No idle timeout: answers that drive a session can take longer than Bun's default 10 s, and the
  // event stream is quiet between pings (main's node:http had none either). Not development: a
  // throw that got past answer() must never serve Bun's error page with the source and the cwd.
  // No port reuse: without development Bun reuses the port by default, and a second board on it
  // would start too (two schedulers) instead of failing with EADDRINUSE as on main.
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      development: false,
      reusePort: false,
      fetch: answer,
    })
  } catch (err) {
    // The port is taken (EADDRINUSE, which the terminal board retries): nothing may keep running.
    // The tunnel is the web port's board's: this one never listens for it, and never touches its
    // ssh (the supervisor, which started nothing, is left alone: closing it would end the
    // recorded ssh, the other board's).
    accessOut.cancel()
    events.close()
    void tunnel.close()
    throw err
  }
  // The tunnel is this board's now. Its ssh dies with it, also on an exit that skips close():
  // run.ts restarts the board by process.exit(75).
  process.on('exit', supervisor.killNow)
  // A login by password's ssh runs in a session of its own: ended with the board too.
  process.on('exit', endLogins)
  nsTokens.refresh()

  // The master door on a node (#498, server/node-listener.ts), its masters and its status: made the
  // first time config.json has `node`, and from then on following it. Without `node` nothing of it
  // exists: no listener, no timer, no file read.
  let relayDial: RelayDial | null = null
  // A node's calls to its master (#508, services/node/uplink.ts): the outbox and its stream on the
  // door, and `POST /api/node/call` for this computer's own `board thread`, on this listener alone.
  let nodeUplink: NodeUplink | null = null
  let nodePilotCall: NodePilotCall | null = null
  let nodePilotBridge: NodePilotBridge | null = null
  // A node's requests to its master (#764, services/node/master-relay.ts): the route first in this board's
  // own table (never the door's), and the stream the master holds on the door.
  let masterRelay: MasterRelay | null = null
  let masterRelayFirst: Route | null = null
  // A node's update of its plugin (#590), made with the door; on Windows (#699) it is told when the
  // start is whole (the end of startServer).
  let nodeUpdate = null as NodeUpdate | null
  const nodePlatform = process.env.BOARD_TEST_PLATFORM || process.platform
  let localCallRoutes: Route[] | null = null
  let localPilotCallRoutes: Route[] | null = null
  let nodePilotCalls: NodePilotCalls | null = null
  let pilotBridgeRunner: PilotBridgeRunner | null = null
  let masterRelayRunner: MasterRelayRunner | null = null

  function ensureLocalPilotCall(): NodePilotCall {
    if (nodePilotCall) return nodePilotCall
    nodePilotCall = createNodePilotCall({
      profiles: () => deps.profiles(),
      homes: deps.homes,
      items: board.items,
      refresh,
      log,
    })
    process.on('exit', nodePilotCall.closeAll)
    return nodePilotCall
  }

  function refreshLocalPilotCallRoutes(): void {
    localPilotCallRoutes =
      nodePilotCalls || nodePilotBridge ? pilotCallRoutes({ master: nodePilotCalls, node: nodePilotBridge }) : null
  }
  function relayDialFollows(): void {
    const n = nodeConfig(cfg.node)
    if (relayDial) {
      void relayDial.sync()
      return
    }
    if (!n?.relay || !n.tls) return
    relayDial = createRelayDial({
      node: () => nodeConfig(cfg.node),
      doorPort: () => door?.listening() ?? null,
      log,
    })
    process.on('exit', relayDial.killNow)
    void relayDial.sync()
  }
  function doorFollows(): void {
    if (door) {
      door.configChanged()
      nodePilotBridge?.sync()
      masterRelay?.sync()
      relayDialFollows()
      return
    }
    if (nodeConfig(cfg.node) === null) return
    // The bundle its master sends (#506): files under the profile folders and `<state>/node/` only.
    // The owner's git identity and GitHub login from its master (#609): git and gh found once here.
    const nodeGit = createNodeGit({ dir: nodeDir(), tools: gitTools(), audit: auditBundle, log })
    const nodeBundle = createNodeBundle({
      ...nodeBundleDeps({ dir: nodeDir(), profiles: () => shownProfiles(deps.profiles().list), log }),
      identity: (given, master) => nodeGit.identity(given, master),
    })
    // The secrets a profile needs, when its master's owner lets this node have them (#604): through
    // the file sink's own writer into the env file and the profile folder.
    const nodeSecrets = createNodeSecrets({
      dir: nodeDir(),
      profiles: () => shownProfiles(deps.profiles().list),
      write: writeSink,
      audit: auditBundle,
      git: nodeGit,
      log,
    })
    const status = createNodeStatus({
      node: () => nodeConfig(cfg.node),
      // The MokuTab functions folder's stamp (#864): one look at the folder, nothing without it.
      functions: () => ownFunctions().stamp(),
      items: board.items,
      launches: () => launches.list(),
      profiles: () => shownProfiles(deps.profiles().list),
      launch: () => cfg.launch,
      version: PLUGIN_VERSION,
      bundle: nodeBundle.version,
      commit: runningCommit,
      programs: () => [...programsOnPath(NODE_PROGRAMS), ...nodeGit.programs()],
      git: () => nodeGit.facts(),
      agyLimits: () => localAgyLimits(cfg.launch),
      addresses: () => ownAddresses().filter(isRoutableNodeAddress),
      // A checkout updates by git in place, anything else from the master's archive (#793).
      updates: () => (holdsGit(pluginRoot()) ? 'git' : 'archive'),
    })
    // The plugin at the master's commit (#590): unpacked beside this one, installed, swapped in; a
    // plugin that is a git checkout is updated in place by git instead, never replaced (#793).
    // Then the board ends with 75 and run.ts, the pane's process, starts it again from the plugin's
    // folder: herdr and the agents' panes are not touched. The code touched first wakes the watchers
    // of run.ts and wake-run.ts, so wake comes back on the new code too. On Windows (#699) the folder
    // cannot be swapped under a running board: a guard process puts the files in place when this
    // board says go (it writes none of them itself), and puts the copy before back when this board
    // does not come back on the new commit.
    const root = pluginRoot()
    const update = createNodeUpdate({
      root,
      dir: join(nodeDir(), 'update'),
      commit: runningCommit,
      // BOARD_TEST_PLATFORM: a test on Windows updates a scratch plugin as a Linux node does (unset in production).
      platform: nodePlatform,
      // run.ts starts the board over IPC: with no such parent nothing would start it again.
      canRestart: typeof process.send === 'function',
      // The guard is the code that runs now, from its copy in `old`: that folder stays as it is
      // while the guard changes the plugin's files.
      guard: (file, old) => startGuard(join(old, 'src', 'entrypoints', 'node-update-guard.ts'), file),
      // After the answer, so it reaches the master before the files change and the board restarts.
      go: file => goLater(file, RESTART_AFTER_MS, log),
      // The board runs the installer once for each commit it starts on (#797), as the board's own
      // update does, so the skills in the Claude profiles are the running code's.
      installer: () => runInstaller(root),
      backupSettings: () => backupSettings(),
      restart: old => {
        touchCode(old)
        touchCode(root)
        // The terminal board's own restart (tui/app.ts: quit(75), which puts the terminal back
        // first), as run.ts asks for it on a code change; a board that has none ends with 75.
        setTimeout(() => {
          process.emit('message', 'restart', undefined)
          setTimeout(() => process.exit(75), RESTART_AFTER_MS)
        }, RESTART_AFTER_MS)
      },
      log,
    })
    nodeUpdate = update
    const uplink = createNodeUplink({ log })
    nodeUplink = uplink
    localCallRoutes = nodeCallRoutes(uplink)
    const pilotCall = ensureLocalPilotCall()
    nodePilotBridge = createNodePilotBridge({
      cfg,
      port: () => server.port ?? port,
      localPilotCall: pilotCall,
      items: board.items,
      profiles: () => deps.profiles(),
      log,
    })
    const upRelay = createMasterRelay({
      cfg,
      items: board.items,
      log,
      // What this node answers itself (#786): a Team of its own config.json, and a start the master placed here.
      stays: (entry, raw) =>
        entry.group === 'team'
          ? teamConfig(cfg.team) !== null
          : entry.group === 'launch' && /^\/api\/launch\/[\w-]+\//.test(raw)
            ? launches.list().some(l => l.id === raw.split('/')[3])
            : entry.group === 'launch' &&
              process.platform === 'win32' &&
              nodeConfig(cfg.node)?.id === 'win-laptop' &&
              /^\/api\/launch(?:\/options)?$/.test(raw),
    })
    const upFlags = createNodeMasterFlags({ cfg, log, changed: () => void runRefresh() })
    nodeFlags = upFlags
    upFlags.apply()
    // The master's time, calendar, journal and presence for this node's page (#780).
    const upSlices = createNodeMasterSlices({
      relay: upRelay,
      flags: upFlags.current,
      changed: () => void runRefresh(),
      log,
    })
    nodeSlices = upSlices
    masterRelay = upRelay
    // An answer or a Hold the master took (#784): its decisions again at once, so the page shows it.
    masterRelayFirst = masterRelayRoute(upRelay, (method, rawPath, status) => {
      if (method === 'POST' && rawPath === DECISIONS_PATH && status === 200) upSlices.poke()
    })
    routes.unshift(masterRelayFirst)
    // Before the relay (#860): the bridge's store token is checked here, where it was written.
    routes.unshift(nsNodeRoute(upRelay, given => nsTokens.check(given)))
    const nodeTelegram = createNodeTelegram({ cfg, profiles: () => deps.profiles(), log, refresh })
    refreshLocalPilotCallRoutes()
    const nodeLaunch = createNodeLaunch({
      node: () => nodeConfig(cfg.node),
      start: (body, session, o) =>
        launches.start(body, board.items(), {
          node: { session, ...(o?.exactSession && { exactSession: true }) },
          ...(o?.trust && { trust: true }),
          ...(o?.by && { by: o.by }),
        }),
      launch: id => launches.list().find(l => l.id === id),
      profiles: () => deps.profiles(),
      workspaces: () => workspaceList(8000),
      // A start by a repository's address runs in a checkout this computer already has (#816).
      known: () =>
        knownFolders({
          sessions: board.items(),
          archived: listArchive(),
          profileDirs: deps.profiles().list.map(p => p.dir),
          home: homedir(),
        }),
    })
    const nodeStore = createNodeStore()
    doorStore = nodeStore
    const nodeJoin = createNodeJoinStore()
    const nodeHandover = createNodeHandover({
      cfg,
      nodeStore,
      commit: runningCommit,
      nodeLinks: () => nodeLinks,
      tunnelStatus: () => supervisor.status(),
      teamState: () => team.view()?.state ?? 'off',
      beforeDbReplace,
      afterDbReplace,
      reloadConfig: reloadLiveConfig,
      relayOps: createLocalRelayOps({
        cfg,
        hostName: () => hostname(),
        log,
        createSetup: deps => createRelaySetup(deps as never),
      }),
      log,
    })
    door = createNodeListener({
      cfg,
      routes: ownRoutes,
      // The board's own files are none of a master's (#501): as through the tunnel, the routes that
      // read by a path refuse them, so a master's page, or the owner's login through the master's
      // tunnel, reads no token or env file of this node's board.
      guards: { ...guards, ownFiles: ownFileCheck(cfg) },
      hello: () => listener.hello(),
      store: nodeStore,
      join: nodeJoin,
      stageRelayKey: () => stageNodeRelayKey(nodeDir()),
      // Its status, a start from the master (#504) through this board's own launch pipeline, the
      // profile bundle its master sends (#506) and a secret given to one of its sinks (#507).
      doorRoutes: nodeDoorRoutes({
        status: () => status.answer(),
        launch: body => nodeLaunch.answer(body),
        bundle: nodeBundle,
        secrets: nodeSecrets,
        // Its own profiles (#802): the live config's `node.ownProfiles`, as the status reads it.
        ownProfiles: () => nodeConfig(cfg.node)?.ownProfiles === true,
        uplink,
        // A secret the owner gives one of this node's sinks (#507): config.json as it is now, as a
        // form's answer reads it, so the sink checked is the one the bundle last wrote.
        sink: (id, body) => giveSecret(loadConfig(), id, { values: body.values, fingerprint: body.fingerprint }),
        // The master revokes this node (#510): its awake sessions to sleep by the board's own bulk
        // sleep (sleepMany, which asks herdr for each first), then that master forgotten, which ends
        // its streams. A session it keeps (at work, in a dialog, wake down) is counted and the
        // master is forgotten all the same: a revoke is not refused for a session.
        leave: async (master, sleep) => {
          let slept = 0
          let kept = 0
          if (sleep) {
            const items = board.items()
            const awake = items.filter(i => i.pane && !i.sleeping).map(i => i.key)
            const results = awake.length ? await sleepMany(deps, items, awake) : []
            slept = results.filter(r => r.result === 'asleep').length
            kept = results.length - slept
            log(`node: the master ${master} leaves; ${slept} of ${results.length} sessions put to sleep`)
            refresh()
          }
          // What this master's bundles gave (#609): the secrets of #604, the GitHub login, the identity.
          // Whatever comes of it, the master is forgotten: a revoke is not refused for it either.
          try {
            const [secretsOut, gitOut] = await Promise.all([
              nodeSecrets.leave(master),
              nodeGit.leave(master).catch(() => ({ identity: false, logins: [], failed: ['git'] })),
            ])
            return { slept, kept, takenOut: { ...secretsOut, ...gitOut } }
          } finally {
            nodePilotCall?.closeAll()
            nodePilotBridge?.close()
            upRelay.drop()
            nodeStore.forget(master)
          }
        },
        update,
        move: movers(),
        pilotCall,
        pilotBridge: nodePilotBridge,
        masterRelay: upRelay,
        // Each post of the flags (the master's stream just opened, or every 5 minutes) asks for the slices too.
        masterFlags: {
          take(raw) {
            const answer = upFlags.take(raw)
            upSlices.poke()
            return answer
          },
        },
        // The owner's desk (#788): the master asks this computer's idle time and sends its notifications here.
        desk: createNodeDesk({
          desktop: desktopHere,
          observe: observeHere,
          reminder: localReminders,
          team: localTeam,
          notice: localNotice,
        }),
        telegram: nodeTelegram,
        relayKey: async publicKey => {
          const r = activateNodeRelayKey(publicKey, nodeDir())
          if (!r.ok) return { status: r.status, body: { ok: false, error: r.error } }
          if (r.rotated) setTimeout(() => void relayDial?.restart(), 50)
          return { status: 200, body: { ok: true, rotated: r.rotated } }
        },
        handover: nodeHandover,
        functions: ownFunctions(),
      }),
      log,
      onChange: () => {
        void relayDial?.sync()
        board.publish()
      },
      onMasterChange: () => board.publish(),
    })
    void door.sync()
    relayDialFollows()
    board.publish()
  }

  // The master's links to its nodes (#499, services/nodes/links.ts) and `/api/nodes` on this board
  // alone: made the first time config.json has `nodes`, and from then on following it. Without
  // `nodes` nothing of it exists: no ssh, no timer, no file, no route.
  const registeredNodeAddresses = (): string[] => {
    const conf = nodesConfig(cfg.nodes, hostname())
    if (!conf || !nodeLinks?.on()) return []
    const out = [...configuredNodeAddresses(conf)]
    for (const dev of nodeLinks.view().devices) {
      const cfgDev = conf.devices[dev.id]
      if (
        !cfgDev ||
        cfgDev.revoked ||
        dev.revoked ||
        dev.link?.state !== 'online' ||
        !dev.status?.addresses ||
        cfgDev.pilotBridge === false
      )
        continue
      for (const addr of dev.status.addresses) {
        if (isRoutableNodeAddress(addr)) out.push(addr)
      }
    }
    return out
  }
  let localNodeRoutes: Route[] | null = null
  let localTelegramRoutes: Route[] | null = null
  let nodeProxy: NodeProxy | null = null
  let bundleSync: BundleSync | null = null
  // The MokuTab functions registry synced through this master (#864): made with the links, gone with them.
  let fnSyncRunner: { kick(): void; close(): void } | null = null
  let uplinkRunner: UplinkRunner | null = null
  let nodeRevoker: Revoker | null = null
  // "Add a server" (#509, services/nodes/setup.ts): the form's two routes on this listener alone,
  // with or without `nodes`, as a board's first device makes it a master. The service is made the
  // first time the form asks: a board that never opens it runs none of it.
  let nodeSetup: NodeSetup | null = null
  const setupSelfId = (): string => nodesConfig(cfg.nodes, hostname())?.id ?? deviceIdFromHost(hostname())
  const localSetupRoutes = nodeSetupRoutes(
    () =>
      (nodeSetup ??= createNodeSetup({
        cfg,
        ssh: () => sshBin(),
        sshVersion,
        knownHosts: knownHostsReady,
        hostKeyPinned,
        hostKeyFingerprint,
        spawn: spawnRemote,
        store: createDeviceStore(),
        // as `board nodes key` makes it: kept when it is there
        linkKey: async (id, make) => {
          const key = createDeviceStore().keyPath(id)
          if (existsSync(key)) return publicKeyOf(key)
          return make ? generateKey(`agent-board ${setupSelfId()} to ${id}`, key) : null
        },
        commit: () => headCommit(ROOT),
        archive: commit => archiveCommit(ROOT, commit),
        editNodes: editNodesAdding,
        follow: linksFollow,
        links: () => nodeLinks,
        bundles: () => bundleSync,
        hostName: () => hostname(),
        onChange: () => {},
        log,
        now: () => Date.now(),
        newId: setupId,
        linkWaitMs: knobMs('BOARD_NODE_SETUP_LINK_MS', 120_000),
        pause,
      })),
  )
  let relaySetup: RelaySetup | null = null
  const localRelaySetupRoutes = relaySetupRoutes(
    () =>
      (relaySetup ??= createRelaySetup({
        cfg,
        ssh: () => sshBin(),
        sshVersion,
        knownHosts: knownHostsReady,
        hostKeyPinned,
        hostKeyFingerprint,
        spawn: spawnRemote,
        relayKey: async (kind, make) => {
          const key = relayKeyPath(kind)
          if (existsSync(key)) return publicKeyOf(key)
          return make ? generateKey(`agent-board relay ${kind} ${setupSelfId()}`, key) : null
        },
        dropRelayKeys: () => dropRelayCredentials(),
        editNodes: editNodesAdding,
        follow: linksFollow,
        hostName: () => hostname(),
        onChange: () => {},
        log,
        now: () => Date.now(),
        newId: setupId,
      })),
  )
  let computerSetup: ComputerSetup | null = null
  const relayPool = createRelayForwardPool()
  const pendingEnrolsFile = (): string => join(nodesDir(), 'relay', 'pending-enrols.json')
  const computerSetupInstance = (): ComputerSetup =>
    (computerSetup ??= createComputerSetup({
      cfg,
      relayHostKey: readRelayHostKey,
      generateDialKey: async socket => {
        const dir = mkdtempSync(join(tmpdir(), 'ab-dial-'))
        try {
          const keyPath = join(dir, 'dial')
          const made = await generateKey(`agent-board relay node ${socket}`, keyPath)
          if (!made.ok) return made
          return { ok: true, publicKey: made.publicKey, privateKey: readFileSync(keyPath, 'utf8') }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      enrol: {
        add: (relay, socket, publicKey) => relayEnrolFor(relay, { store: createDeviceStore() }).add(socket, publicKey),
        remove: (relay, socket) => relayEnrolFor(relay, { store: createDeviceStore() }).remove(socket),
      },
      probe: (relay, socket) => probeComputerDoor(relay, socket, { pool: relayPool }),
      claim: (relay, socket, req) => claimComputerDoor(relay, socket, req, { pool: relayPool }),
      activateRelayKey: (relay, socket, req) => activateComputerRelayKey(relay, socket, req, { pool: relayPool }),
      releaseProbe: socket => {
        void relayPool.drop(socket)
      },
      pinCert: (deviceId, certPem) => {
        createDeviceStore().setCert(deviceId, certPem)
      },
      store: createDeviceStore(),
      editNodes: editNodesAdding,
      follow: linksFollow,
      links: () => nodeLinks,
      bundles: () => bundleSync,
      commit: runningCommit,
      hostName: () => hostname(),
      pendingFile: pendingEnrolsFile,
      onChange: () => {},
      log,
      now: () => Date.now(),
      newId: setupId,
      joinTtlMs: knobMs('BOARD_NODE_JOIN_TTL_MS', JOIN_TTL_MS),
      pollMs: knobMs('BOARD_NODE_JOIN_POLL_MS', 5000),
      linkWaitMs: knobMs('BOARD_NODE_SETUP_LINK_MS', 120_000),
      retryBaseMs: knobMs('BOARD_NODE_ENROL_RETRY_MS', 5000),
      retryMaxMs: knobMs('BOARD_NODE_ENROL_RETRY_MAX_MS', 60_000),
      pause,
    }))
  const localComputerSetupRoutes = computerSetupRoutes(computerSetupInstance)
  let masterHandover: MasterHandover | null = null
  const hasHandoverRoute = (): boolean => !!localNodeRoutes || readHandoverState() !== null
  const localHandoverRoutes = handoverRoutes(
    () =>
      (masterHandover ??= createMasterHandover({
        cfg,
        links: () => nodeLinks,
        commit: runningCommit,
        setFreeze: setHandoverFreeze,
        beforeDbReplace,
        afterDbReplace,
        reloadConfig: reloadLiveConfig,
        checkLocalRelay: co =>
          createLocalRelayOps({
            cfg,
            hostName: () => hostname(),
            log,
            createSetup: deps => createRelaySetup(deps as never),
          }).check(co),
        undoLocalRelay: uo =>
          createLocalRelayOps({
            cfg,
            hostName: () => hostname(),
            log,
            createSetup: deps => createRelaySetup(deps as never),
          }).undo(uo),
        localDoor: () => ({
          listening: door?.listening() ?? null,
          error: door?.error() ?? null,
          relay: relayDial
            ? {
                state: relayDial.status().state,
                ...(relayDial.status().error && { error: relayDial.status().error }),
                idleReason: relayDial.idleReason(),
              }
            : null,
        }),
        log,
      })),
  )
  let nodeUpdater: NodeUpdater | null = null
  let scheduler: ReturnType<typeof startScheduler> | null = null
  function linksFollow(): void {
    // `nodes` gone from config.json while the board runs (an old master a handover's commit made a
    // node, #726): what only a master runs is closed, not left idle behind the config's gates.
    if (nodeLinks && nodesConfig(cfg.nodes) === null) {
      masterNodesStop(nodeLinks)
      return
    }
    if (nodeLinks) {
      nodeLinks.configChanged()
      pilotBridgeRunner?.sync()
      masterRelayRunner?.sync()
      scheduler?.wakeDevices()
      return
    }
    if (nodesConfig(cfg.nodes) === null) return
    if (nodesConfig(cfg.nodes)?.relay && existsSync(pendingEnrolsFile())) {
      void computerSetupInstance().sweepExpired()
    }
    nodeLinks = createNodeLinks({ cfg, log, commit: runningCommit, boardUrl: () => masterBoardUrl(cfg.tunnel) })
    nodeLinks.onChange(id => scheduler?.wakeDevice(id))
    // Where a new session runs (#504), and the Devices row of this computer (#500): this computer's
    // own status by the code a node answers with.
    const ownStatus = createNodeStatus({
      node: () => {
        const n = nodesConfig(cfg.nodes)
        return n && { id: n.id, port: 0, workRoot: '~', listen: 'loopback', tls: false, relay: null }
      },
      items: board.items,
      launches: () => launches.list(),
      // Every profile this computer has: a start may name a hidden one, as without nodes.
      profiles: () => deps.profiles().list,
      launch: () => cfg.launch,
      version: PLUGIN_VERSION,
      commit: runningCommit,
      agyLimits: () => localAgyLimits(cfg.launch),
    })
    nodeAggregate = createNodeAggregate({
      links: nodeLinks,
      cfg,
      log,
      onChange: () => board.publish(),
      ownStatus: () => ownStatus.answer(),
      statusMs: linkTimes().statusMs,
      update: id => nodeUpdater?.view(id) ?? null,
      allowCallParent: (device, parentKey) => nodePilotCalls?.allowsCallParent(device, parentKey) ?? false,
    })
    // This board's commit shipped to a node on another one (#590): by itself when none of its
    // sessions is in a turn, at once when asked. A board with no git checkout has nothing to send.
    const root = pluginRoot()
    nodeUpdater = createNodeUpdater({
      links: nodeLinks,
      commit: runningCommit,
      canShip: async () => (await headCommit(root).catch(() => null)) !== null,
      archive: commit => archiveCommit(root, commit),
      onChange: () => board.publish(),
      revoked: id => nodesConfig(cfg.nodes)?.devices[id]?.revoked === true,
      log,
    })
    // An offline copy still due is written also on an exit that skips close().
    process.on('exit', nodeAggregate.close)
    // The profile bundle per device (#506): built and hashed when asked and every 5 minutes.
    bundleSync = createBundleSync({
      cfg,
      links: nodeLinks,
      // Every profile: a start may run in a hidden one (a parent's), and its node is made current
      // for it like any other (#584); the 5 minute hash leaves hidden ones out by itself.
      profiles: () => deps.profiles().list,
      store: createDeviceStore(),
      log,
      // Which secrets went to which device (#604), names only, in the audit a given secret has.
      audit: auditBundle,
      // The owner's git identity with every bundle, and his GitHub login with the secrets (#609).
      git: masterGit(gitTools()),
    })
    // The MokuTab functions registry (#864): this computer's folder and each owner device's online.
    const fnLinks = nodeLinks
    const masterId = (): string => nodesConfig(cfg.nodes, hostname())?.id ?? 'master'
    const online = (id: string): boolean => fnLinks.link(id)?.state().state === 'online'
    const fnSyncNow = createFnSync({
      dir: join(stateDir(), 'fn-sync'),
      replicas: () => [
        localReplica(masterId(), ownFunctions()),
        ...fnSyncDevices(nodesConfig(cfg.nodes, hostname()), online).flatMap(id => {
          const link = fnLinks.link(id)
          return link ? [linkReplica(id, link)] : []
        }),
      ],
      log,
    })
    fnSyncRunner = createFnSyncRunner({
      sync: fnSyncNow,
      local: ownFunctions(),
      nodes: () => nodesConfig(cfg.nodes, hostname()),
      links: fnLinks,
      log,
    })
    // Requests for a node's card (#501): first in the route table, which the phones' listener and the
    // tunnel share, so they reach it after their own refusals. Without `nodes` the table is main's.
    const aggregate = nodeAggregate
    const pilotCalls = createNodePilotCalls({
      cfg,
      links: nodeLinks,
      port: () => server.port ?? port,
      log,
      localPilotCall: ensureLocalPilotCall(),
      ownItems: board.items,
      remoteItems: () => aggregate.part()?.items ?? [],
      masterId: () => nodesConfig(cfg.nodes, hostname())?.id ?? '',
      profiles: () => deps.profiles(),
    })
    nodePilotCalls = pilotCalls
    refreshLocalPilotCallRoutes()
    pilotBridgeRunner = createPilotBridgeRunner({
      links: nodeLinks,
      pilotCalls,
      log,
      deviceIds: () => Object.keys(nodesConfig(cfg.nodes)?.devices ?? {}).filter(id => id !== LOCAL),
    })
    // Requests a node relays (#764): run here as a remote owner's would be, the node proxy included.
    const deviceOf = (id: string) => {
      const d = nodesConfig(cfg.nodes, hostname())?.devices[id]
      return d && !d.revoked && id !== LOCAL ? d : null
    }
    masterRelayRunner = createMasterRelayRunner({
      links: nodeLinks,
      log,
      deviceIds: () => Object.keys(nodesConfig(cfg.nodes)?.devices ?? {}).filter(id => id !== LOCAL),
      selfId: () => nodesConfig(cfg.nodes, hostname())?.id ?? '',
      ownerAllowed: id => {
        const d = deviceOf(id)
        return !!d && d.owner !== false
      },
      sessionKnown(id, key) {
        if (!deviceOf(id)) return false
        try {
          return !!board.findAny(nodeKey(id, key))
        } catch {
          return false
        }
      },
      replay: (req, from) => replayRelayed(req, from),
      // The master-owned features for the nodes (#775).
      flags: () => masterFlagsFor(cfg, nodesConfig(cfg.nodes, hostname())?.id ?? '', presence.view()),
    })
    presenceToNodes = () => masterRelayRunner?.flagsChanged()
    nodeProxy = createNodeProxy({
      cfg,
      links: nodeLinks,
      find: board.findAny,
      own: board.items,
      remote: () => aggregate.part()?.items ?? [],
      local: ownRoutes,
      async pilotCall(req, ctx, p) {
        const prefixed = `@${p.device}:${p.key}`
        const item = board.findAny(prefixed)
        if (!item) return json(404, { ok: false, error: t('err.gone') })
        const viewer = { peer: ctx.peer(), forwardedFor: req.headers.get('x-forwarded-for') }
        const r = await pilotCalls.startForItem(item, viewer)
        return json(r.ok ? 200 : 409, r)
      },
    })
    routes.unshift(nodeProxy.route)
    const nodesTelegram = createNodesTelegram({
      cfg,
      links: nodeLinks,
      aggregate: nodeAggregate,
      deviceState: id => nodeProxy?.deviceState?.(id) ?? 'offline',
      onHeld: () => {
        board.publish()
        scheduler?.wakeDevices()
      },
      log,
    })
    localTelegramRoutes = [
      {
        method: 'POST',
        path: '/api/nodes/telegram',
        guard: ['board-header', 'origin'],
        async handle(req) {
          const raw = await req.text().catch(() => '')
          if (raw.length > 512 * 1024) return json(413, { ok: false, error: 'too-big' })
          let body: unknown = null
          try {
            body = JSON.parse(raw || '{}')
          } catch {
            return json(400, { ok: false, error: 'body' })
          }
          const r = await nodesTelegram.route(body)
          return json(r.status, r.body)
        },
      },
    ]
    // Calls from the nodes' sessions (#508, #698): forwarded commands run here as that session.
    uplinkRunner = createUplinkRunner({
      links: nodeLinks,
      find: board.findAny,
      items: () => {
        const masterId = nodesConfig(cfg.nodes, hostname())?.id ?? ''
        return dropMovedCards([...board.items(), ...(aggregate.part()?.items ?? [])], masterId)
      },
      // Case files (#488): the same cards, a device not heard now marked as its copy.
      caseItems: () => caseItems(board.items(), aggregate.part()),
      cfg,
      log,
      webPort: () => Number(server.port) || Number(cfg.port) || 12422,
      setPresence: (state, from) => presence.set(state, from),
      frozen: () => handoverFrozen,
      // spawn-agent on a node (#760): placed by this board as one of its own starts.
      spawn: {
        start: (body, options) => {
          const masterId = nodesConfig(cfg.nodes, hostname())?.id ?? ''
          return launches.start(
            body,
            dropMovedCards([...board.items(), ...(aggregate.part()?.items ?? [])], masterId),
            options,
          )
        },
        profiles: () => deps.profiles(),
        workspaces: () => workspaceList(8000),
        herdrName: async pane => (await import('../services/launch/spawn-board.ts')).herdrName(pane),
        dismiss: id => {
          launches.dismiss(id)
        },
      },
    })
    const masterCheckouts = createCheckouts()
    const placer = createPlacer({
      cfg,
      links: nodeLinks,
      remote: () => aggregate.part(),
      launches,
      items: board.items,
      ownStatus: () => ownStatus.answer(),
      bundle: bundleSync,
      commit: runningCommit,
      updating: id => nodeUpdater?.updating(id) ?? false,
      // board-state.ts tells the placer this computer's sessions after each read of herdr.
      awaitsBoard: true,
      // A node's repository a session it asked for runs in here (#760).
      checkout: async source => {
        const got = await masterCheckouts.folderOf(nodesConfig(cfg.nodes, hostname())?.workRoot ?? '~/work', source)
        return got.ok ? { ok: true, cwd: got.cwd } : got
      },
      fillThresholds: (id, given) => {
        const r = editNodes(raw => fillThresholds(raw, id, given))
        if (!r.ok) log(`placer: the thresholds of ${id} were not written: ${r.error}`)
      },
      log,
    })
    nodePlacer = placer
    // A device revoked (#510): marked in config.json and seen by the live config at once, so the
    // placer refuses it from that instant; then told and forgotten (services/nodes/revoke.ts).
    const links = nodeLinks
    nodeRevoker = createRevoker({
      links,
      store: createDeviceStore(),
      config: () => nodesConfig(cfg.nodes),
      mark: id => {
        let found = false
        const r = editNodes(nodes => {
          found = isRecord(nodes.devices) && isRecord(nodes.devices[id])
          return markRevoked(nodes, id)
        })
        // A device the file does not hold: the live config is not marked behind its back.
        if (r.ok && !found) return { ok: false, error: 'device' }
        // The live config at once, not ~120 ms later when its watcher follows the file.
        if (r.ok && isRecord(cfg.nodes)) {
          const next = structuredClone(cfg.nodes)
          if (markRevoked(next, id)) cfg.nodes = next
          pilotCalls.revokeForNode(id)
          scheduler?.wakeDevice(id)
        }
        return r
      },
      log,
    })
    // Whether a device has a token stored, for the panel's words (never the token itself).
    const panelStore = createDeviceStore()
    localNodeRoutes = nodesRoutes(
      nodeLinks,
      bundleSync,
      {
        config: () => nodesConfig(cfg.nodes),
        edit: change => {
          let snapshot: Record<string, unknown> | null = null
          const r = editNodes(nodes => {
            const changed = change(nodes)
            if (changed) snapshot = structuredClone(nodes)
            return changed
          })
          if (r.ok && snapshot) {
            cfg.nodes = snapshot
            linksFollow()
            board.publish()
          }
          return r
        },
        seen: () => readLanesSeen(),
        keepSeen: ids => writeLanesSeen(ids),
        ownStatus: () => ownStatus.answer(),
        hasToken: id => panelStore.token(id) !== null,
        next: n => {
          // A plain start: the board's default profile, a lane that may leave when one does.
          const lane = n?.lanes === 'all' ? (cfg.categories[0]?.id ?? '') : (n?.lanes[0] ?? '')
          const list = deps.profiles().list
          const profile = list.find(p => p.inherited)?.id ?? list[0]?.id ?? ''
          return placer.next(lane, profile, n)
        },
      },
      nodeRevoker,
      nodeUpdater,
      () => heldByDevice(listEntries()),
      fnSyncNow,
    )
    // Their ssh dies with the board, also on an exit that skips close().
    process.on('exit', nodeLinks.killNow)
  }

  /**
   * Closes and drops what linksFollow made for a master (#726): the node proxy's route and the
   * Devices routes leave the tables, the runners and the links stop. All of it is dropped at once,
   * so `nodes` coming back (a rollback) makes everything afresh; the closes finish behind it.
   */
  function masterNodesStop(links: NodeLinks): void {
    if (nodeProxy) {
      const at = routes.indexOf(nodeProxy.route)
      if (at >= 0) routes.splice(at, 1)
    }
    nodeProxy = null
    localNodeRoutes = null
    localTelegramRoutes = null
    presenceToNodes = () => {}
    const aggregate = nodeAggregate
    const bridge = pilotBridgeRunner
    const relay = masterRelayRunner
    const uplink = uplinkRunner
    const calls = nodePilotCalls
    const parts = [nodePlacer, nodeUpdater, nodeRevoker, bundleSync, fnSyncRunner]
    nodeAggregate = null
    pilotBridgeRunner = null
    masterRelayRunner = null
    uplinkRunner = null
    nodePilotCalls = null
    nodePlacer = null
    nodeUpdater = null
    nodeRevoker = null
    bundleSync = null
    fnSyncRunner = null
    nodeLinks = null
    refreshLocalPilotCallRoutes()
    if (aggregate) {
      aggregate.close()
      process.off('exit', aggregate.close)
    }
    calls?.close()
    for (const p of parts) p?.close()
    void (async () => {
      await bridge?.close()
      await relay?.close()
      await uplink?.close()
      await links.close()
      process.off('exit', links.killNow)
    })()
      .then(() => log('nodes: off in config.json, the master links are closed'))
      .catch(err => log(`nodes: closing the master links: ${messageOf(err)}`))
    board.publish()
  }

  const poll = setInterval(refresh, Math.max(1, cfg.refreshSec ?? 2) * 1000)
  // The update of itself (#617): an update the board before this one merged is finished here, a
  // moment after the start (a second restart from the same pull would cut it short); then a look
  // each minute at whether one is due, which reads the config and nothing else while it is off.
  const selfUpdateSays = (err: unknown): void => log(`self-update: ${err instanceof Error ? err.message : String(err)}`)
  const selfUpdateResume = setTimeout(() => void selfUpdate.resume().catch(selfUpdateSays), 10_000)
  const selfUpdateTick = setInterval(() => void selfUpdate.tick().catch(selfUpdateSays), 60_000)
  const watchers = [
    watchFolder(cards, 150, refresh, log),
    // Entries added or cancelled by agents (`board remind`), and runs the scheduler made.
    watchFolder(scheduleDir(), 150, refresh, log),
    // Sessions an agent put in the archive (`board archive`), whose cards go at once.
    watchFolder(archiveDir(), 150, refresh, log),
    // A change to the page: build it again; the new version makes open pages reload.
    watchFolder(WEB, 200, () => void bundle.rebuild().then(refresh), log, true),
  ]
  // Watches (#486) set, checked or removed, only while config.json turns them on; turned on or off
  // later (Settings, #596), the folder's watcher follows the config.
  let watchesWatcher: { close(): void } | null = null
  const watchesFollow = (): void => {
    const on = watchesConfig(cfg.watches) !== null
    if (on && !watchesWatcher) watchesWatcher = watchFolder(watchesDir(), 150, refresh, log)
    else if (!on && watchesWatcher) {
      watchesWatcher.close()
      watchesWatcher = null
    }
  }
  watchesFollow()
  refresh()
  // The port makes it one board per machine, so one scheduler; claims cover an overlap.
  // Verified done (#492): the scheduler starts verifiers as a fork is started, and archives them after.
  const verifier = createVerifier({
    cfg,
    log,
    start: (body, items, options) => launches.start(body, items, options),
    launchState: id => launches.state(id),
    workspaces: async () => (await workspaceList(8000)).map(w => ({ id: w.id, label: w.label ?? '' })),
    archive: async item => {
      const at = parseNodeKey(item.key)
      if (!at) return (await askArchive(deps, item, { by: 'agent' })).ok ? 'ok' : 'busy'
      const link = nodeLinks?.link(at.device)
      if (link?.state().state !== 'online') return 'busy'
      const res = await link
        .fetch('/api/archive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'archive', keys: [at.key] }),
          signal: AbortSignal.timeout(15_000),
        })
        .catch(() => null)
      if (!res) return 'busy'
      const body = (await res.json().catch(() => null)) as { done?: { key?: unknown }[] } | null
      return res.ok && Array.isArray(body?.done) && body.done.some(d => d?.key === at.key) ? 'ok' : 'busy'
    },
    withDb: fn => withThreadsDb(false, fn),
    profiles: () => shownProfiles(deps.profiles().list).length,
    node: device => {
      const n = nodesConfig(cfg.nodes)?.devices[device]
      if (!n?.link) return null
      const link = nodeLinks?.link(device)
      const st = link?.view().status ?? null
      return {
        configured: true,
        online: link?.state().state === 'online',
        status: st,
        profiles: n.profiles,
        paused: n.paused,
        drain: n.drain,
        ...(n.revoked && { revoked: true }),
      }
    },
    remoteLaunchState: key => {
      const l = nodeAggregate?.part()?.launches.find(x => x.id === key)
      if (l) return { state: l.state, error: l.error, sessionId: l.key }
      const at = parseNodeKey(key)
      const local = at ? launches.sessionState?.(at.key) : null
      return local && local.state !== 'done' ? local : null
    },
    cancelQueued: (launchId, key) => {
      const at = parseNodeKey(key)
      return launches.cancelQueued?.(launchId ?? '', at?.key ?? key) ?? false
    },
  })
  // A reminder for a node's card goes through its node (#501): asked only for a key with a device's
  // prefix, which exists only with `nodes`.
  // Verified done turned off (#596): its held dones go to the owner once, as it goes off. At start, only
  // a config that still keeps a verify section turned off is looked at (switched off while the board
  // was not running); a board that never had verify reads nothing.
  let verifyWas = !!threadsConfig(cfg.threads)?.verify
  const verifyGone = (): void => {
    try {
      verifier.switchedOff()
    } catch (err) {
      log(`verify: ${messageOf(err)}`)
    }
  }
  const verifyFollow = (): void => {
    const on = !!threadsConfig(cfg.threads)?.verify
    if (verifyWas && !on) verifyGone()
    verifyWas = on
  }
  if (!verifyWas && verifyKeptOff(cfg.threads)) verifyGone()
  scheduler = startScheduler({
    deps,
    onChange: refresh,
    remote: () => nodeProxy,
    remoteItems: () => nodeAggregate?.part()?.items ?? [],
    verify: verifier,
  })
  if (handoverFrozen) scheduler.pause()
  workdesk.configChanged()
  workdeskDialog.configChanged()
  void configureWorkdeskStream()
  // Auto-compact (#378) beside it, for the same reason: one board types /compact.
  const compactor = startCompactor({ deps, onChange: refresh })
  // Shells a board before this one opened and that are gone by now are forgotten.
  if (terminalOn(cfg)) void terminals.prune()
  setup.start()
  void listener.sync()
  // The listener first: ssh forwards to it, so it starts only once that listens (a stray ssh a
  // board before left is ended first).
  void tunnel.sync().then(() => supervisor.sync())
  doorFollows()
  linksFollow()
  // Wake on but not running (its startup entry did not run, or it ended): started once.
  void wake.ensure()
  presence.start()
  calendar.configChanged()
  reminders.configChanged()
  if (!handoverFrozen) team.start()
  holdLoopback6()

  // What the Remote access view reads of config.json, and the tunnel's own settings in it, as of
  // the last config change.
  const viewConfig = (): string => JSON.stringify([cfg.tunnel ?? null, cfg.remote ?? null, cfg.language])
  const tunnelSettings = (): string => JSON.stringify(cfg.tunnel ?? null)
  let lastView = viewConfig()
  let lastSettings = tunnelSettings()

  // A node's update is settled by the board that came back on its commit: here, when the whole
  // start is done (a later throw in this function never gets here), and once it stayed up a while.
  // On Windows (#699) that takes the guard's record; everywhere the installer runs once per commit.
  // Only a node has one: a board that is no node schedules nothing.
  if (nodeUpdate) {
    const settled = nodeUpdate
    void pause(UPDATE_STABLE_MS)
      .then(() => settled.started())
      .catch(err => log(`node: settling the update: ${err instanceof Error ? err.message : String(err)}`))
  }

  function setHandoverFreeze(frozen: boolean): void {
    handoverFrozen = frozen
    if (frozen) {
      scheduler?.pause()
      backups.pause()
      team.stop()
      void supervisor.sync()
    } else {
      scheduler?.resume()
      backups.resume()
      team.start()
      void supervisor.sync()
    }
  }

  function beforeDbReplace(): void {
    keepThreadsDb(false)
    keepTimeDb(false)
    journal.stop()
  }

  function afterDbReplace(): void {
    keepThreadsDb(true)
    keepTimeDb(true)
  }

  async function runRefresh(): Promise<void> {
    // A node's master-owned card features (#775) back in the live config after a reload of config.json.
    nodeFlags?.apply()
    listener.configChanged()
    tunnel.configChanged()
    const view = viewConfig()
    if (view !== lastView) {
      lastView = view
      accessChanged()
    }
    const settings = tunnelSettings()
    if (settings !== lastSettings) {
      lastSettings = settings
      syncMasterBoardUrl()
      void supervisor.sync()
    }
    // Turned on in config.json (by hand, or from the panel): started at once.
    wake.configChanged()
    // Presence turned on or off: its sessions marked or unmarked, the board shown again.
    presence.refresh()
    // The calendar turned on or off: its timer started or stopped, its reminders' too.
    calendar.configChanged()
    reminders.configChanged()
    workdesk.configChanged()
    workdeskDialog.configChanged()
    await configureWorkdeskStream()
    if (!handoverFrozen) team.refresh()
    holdLoopback6()
    doorFollows()
    linksFollow()
    watchesFollow()
    verifyFollow()
    housekeeping.sync()
    await board.refresh()
    ownerTick()
  }

  async function reloadLiveConfig(): Promise<void> {
    const next = initialNoFileCfg && readConfigFile() === null ? structuredClone(initialNoFileCfg) : loadConfig()
    for (const k of Object.keys(cfg)) delete (cfg as unknown as Record<string, unknown>)[k]
    Object.assign(cfg, next)
    await runRefresh()
    await door?.sync()
    await Promise.all([relayDial?.sync(), nodeLinks?.follow()])
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    routes,
    // Called when config.json changes, too: the remote mode and the tunnel follow it. The panel
    // fetches its view again when what it reads changed; the tunnel's ssh follows its settings
    // (a new host, say) here, and the listener's port through its onChange.
    refresh: runRefresh,
    async close() {
      nsStore.clear()
      clearInterval(poll)
      clearTimeout(selfUpdateResume)
      clearInterval(selfUpdateTick)
      clearInterval(directoryTick)
      if (directoryTimer) clearTimeout(directoryTimer)
      housekeeping.close()
      for (const watcher of watchers) watcher.close()
      watchesWatcher?.close()
      omarchy?.close()
      scheduler.stop()
      workdeskStreamConfig = ''
      workdeskStream?.controller.abort()
      await Promise.all([workdesk.stop(), workdeskDialog.stop(), workdeskStream?.task])
      await boardEvents.stop()
      nsNotify.stop()
      journal.stop()
      turnResume.stop()
      compactor.stop()
      backups.stop()
      wake.stop()
      presence.stop()
      calendar.stop()
      reminders.stop()
      team.stop()
      terminals.stopAll()
      setup.stop()
      accessOut.cancel()
      events.close()
      threadRevs.close()
      keepThreadsDb(false)
      await listener.close()
      // ssh before the listener it forwards to.
      await supervisor.close()
      process.off('exit', supervisor.killNow)
      endLogins()
      process.off('exit', endLogins)
      await tunnel.close()
      if (relayDial) {
        await relayDial.close()
        process.off('exit', relayDial.killNow)
      }
      await door?.close()
      nodePilotBridge?.close()
      await pilotBridgeRunner?.close()
      masterRelay?.close()
      nodeSlices?.close()
      await masterRelayRunner?.close()
      if (nodePilotCall) {
        nodePilotCall.closeAll()
        process.off('exit', nodePilotCall.closeAll)
      }
      nodePilotCalls?.close()
      nodeUplink?.close()
      await uplinkRunner?.close()
      if (nodeAggregate) {
        nodeAggregate.close()
        process.off('exit', nodeAggregate.close)
      }
      nodePlacer?.close()
      nodeUpdater?.close()
      nodeRevoker?.close()
      computerSetup?.close()
      await relayPool.closeAll()
      bundleSync?.close()
      fnSyncRunner?.close()
      if (nodeLinks) {
        await nodeLinks.close()
        process.off('exit', nodeLinks.killNow)
      }
      await loopback6?.stop(true)
      await server.stop(true)
    },
  }
}
