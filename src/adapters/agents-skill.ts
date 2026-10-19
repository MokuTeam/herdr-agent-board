// The agents' skill (core/setup.ts) in a Claude profile folder: what is at
// <dir>/skills/herdr-agents/SKILL.md, and the board's copy put there by the install action. Only
// that file is read or written; someone else's skill of that name is left alone.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type SkillAction, type SkillFacts, skillAction, skillFile } from '../core/setup.ts'

/** A text file as a string (a BOM taken off), or null. */
function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch {
    return null
  }
}

/** The skill in the profile folder `dir`, next to the board's own copy (`source`, null: none). */
export function skillIn(dir: string, source: string | null): SkillFacts {
  const file = skillFile(dir)
  return { file, installed: read(file), source }
}

/** The board's copy (`source`) into the profile folder `dir`, unless it is there already or someone else's skill is. */
export function installSkill(dir: string, source: string): { file: string; action: SkillAction } {
  const file = skillFile(dir)
  const action = skillAction(read(file), source)
  if (action === 'write') {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return { file, action }
}
