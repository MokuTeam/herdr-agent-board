// What the Remote access panel's "Sync profiles" shows (services/profile-sync.ts keeps it): the
// direction, the preview, a run's progress and its end. No secret is in it: the preview names a
// secret's file and kind, never its value; the passwords are the page's, sent with each request.
import type { AdminHint } from '../server-view.ts'
import type { Direction, Preview } from './plan.ts'

export type SyncPhase = 'idle' | 'looking' | 'preview' | 'applying' | 'done' | 'failed'

export interface SyncProgress {
  files: number
  filesTotal: number
  bytes: number
  bytesTotal: number
  /** What it does now: sending (or receiving) the files, then recording the sync on both sides. */
  step: 'files' | 'record'
}

export interface SyncResult {
  files: number
  bytes: number
  deleted: number
  /** Conflicts left as the target had them. */
  kept: number
  /** Profiles made on the target (the owner signs in to Claude there), and whether the board's install then put its hooks in them (the server's; null: none ran). */
  created: string[]
  install: boolean | null
  /** Files gone on the source between the preview and Apply. */
  gone: number
}

export interface SyncView {
  phase: SyncPhase
  direction: Direction | null
  preview: Preview | null
  progress: SyncProgress | null
  result: SyncResult | null
  hint: AdminHint | null
  error: string | null
}

export const SYNC_IDLE: SyncView = {
  phase: 'idle',
  direction: null,
  preview: null,
  progress: null,
  result: null,
  hint: null,
  error: null,
}
