// This device's server folder → folder here list (models/local-paths.ts), kept in its browser: the
// Paths panel changes it, the quick look reads it. With none kept, the suggestion for its system.
import { devicePlatform, LOCAL_PATHS_KEY, mapsOf, type PathMap, suggestedMaps } from '../models/local-paths.ts'
import { storage } from './storage.ts'
import { Store } from './store.ts'

let kept: Store<PathMap[]> | null = null

/** What this device suggests for itself. */
export const suggestion = (): PathMap[] =>
  suggestedMaps(typeof navigator === 'undefined' ? 'other' : devicePlatform(navigator))

/** The list, read from the browser the first time it is asked for. */
export function localPaths(): Store<PathMap[]> {
  kept ??= new Store(mapsOf(storage.read(LOCAL_PATHS_KEY)) ?? suggestion())
  return kept
}

/** A new list, kept for the next visits too (dropped where the browser keeps nothing). */
export function keepLocalPaths(maps: PathMap[]): void {
  localPaths().set(maps)
  storage.set(LOCAL_PATHS_KEY, JSON.stringify(maps))
}
