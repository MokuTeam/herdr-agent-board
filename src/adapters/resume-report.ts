// What the SessionStart hook needs to have herdr resume a session in its own profile
// (core/resume.ts): whether herdr-wake reports a resume command of its own in the profile, whether
// `board` is on PATH, and the reporter (entrypoints/resume-report.ts), started on its own.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { herdrWakeResumes } from '../core/resume.ts'
import { ROOT } from './paths.ts'

type Env = Record<string, string | undefined>

/** herdr-wake's config.json, where its hook reads it (herdr-wake/src/hook.mjs). */
export const herdrWakeConfigFile = (env: Env = process.env, home: string = homedir()): string =>
  join(env.APPDATA || join(home, '.config'), 'herdr', 'plugins', 'config', 'herdr-wake', 'config.json')

/** A JSON file as read, a BOM taken off (Windows PowerShell writes one); null when none or broken. */
function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/** Whether herdr-wake reports its own resume command for the sessions of the profile in `dir`. */
export function herdrWakeResumesIn(dir: string, env: Env = process.env): boolean {
  const settings = readJsonFile(join(dir, 'settings.json'))
  return herdrWakeResumes(settings, settings ? readJsonFile(herdrWakeConfigFile(env)) : null)
}

/** Whether the `board` command is on PATH (its shims for sh and for PowerShell, see install-plan.ts). */
export const boardOnPath = (env: Env = process.env): boolean =>
  Bun.which('board', { PATH: env.PATH ?? env.Path ?? '' }) !== null

const REPORTER = join(ROOT, 'src', 'entrypoints', 'resume-report.ts')

/** Starts the reporter for the session in `pane`, on its own: the hook does not wait for it. */
export function startResumeReport(pane: string, session: string, command: readonly string[]): void {
  spawn(process.execPath, [REPORTER, pane, session, ...command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}
