// The guard on Stop (#330): a card that works is busy and easy to hit by mistake, so the first
// press only arms Stop (it says so), and a second one stops the turn. A double click is not two
// presses: a second press that comes too soon after the first is ignored, as is the second click
// of a double click. Armed too long ago, a press arms it afresh.

/** How long Stop stays armed after the first press. */
export const ARM_MS = 3000
/** How soon after arming a press counts: quicker is the same gesture (a double click, a bounce). */
export const SETTLE_MS = 350

export type StopPress = 'arm' | 'fire' | 'ignore'

/**
 * What a press on Stop does: `armedAt` is when it was armed (ms), null when it is not; `detail` the
 * click's count (0 from the keyboard).
 */
export function pressStop(armedAt: number | null, now: number, detail = 1): StopPress {
  if (detail > 1) return 'ignore'
  if (armedAt === null || now - armedAt >= ARM_MS) return 'arm'
  return now - armedAt < SETTLE_MS ? 'ignore' : 'fire'
}

/**
 * A press on Stop in the message box (#340): one press stops, as in any chat app, with no arming.
 * The button was Send a moment ago, so the second click of a double click on Send, or a press
 * within SETTLE_MS of the button turning into Stop (`shownAt`, ms), is the same gesture and stops
 * nothing.
 */
export const pressComposerStop = (shownAt: number, now: number, detail = 1): boolean =>
  detail <= 1 && now - shownAt >= SETTLE_MS
