// The viewer's choice of light or dark (Settings), before the page paints, so it never flashes
// the other one. Without a choice the page follows the system. Kept in this browser. The server
// bundles it as theme.js (server/web-bundle.ts), which web/index.html loads ahead of the styles.
// The style (Classic or Terminal, models/look.ts) the same way: only Terminal sets one, picked here
// or, with none picked, the board's own (data-look-default, from config.json). Wrapped card text
// (models/card-text.ts) too: only a kept Wrap sets one.
import { CARD_TEXT_KEY, keptCardText } from './models/card-text.ts'
import { keptLook, LOOK_KEY } from './models/look.ts'
import { keptTheme, THEME_KEY } from './models/theme.ts'

/** What this browser keeps under `key`; null when it keeps nothing or will not say. */
const kept = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const root = document.documentElement
const theme = keptTheme(kept(THEME_KEY))
if (theme) root.dataset.theme = theme
const look = keptLook(kept(LOOK_KEY), root.dataset.lookDefault)
if (look) root.dataset.look = look
const cardText = keptCardText(kept(CARD_TEXT_KEY))
if (cardText) root.dataset.cardText = cardText
