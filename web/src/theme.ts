// The viewer's choice of light or dark (Settings), before the page paints, so it never flashes
// the other one. Without a choice the page follows the system. Kept in this browser. The server
// bundles it as theme.js (server/web-bundle.ts), which web/index.html loads ahead of the styles.
// The style (Classic or Terminal, models/look.ts) the same way: only Terminal sets one.
import { keptLook, LOOK_KEY } from './models/look.ts'
import { keptTheme, THEME_KEY } from './models/theme.ts'

try {
  const theme = keptTheme(localStorage.getItem(THEME_KEY))
  if (theme) document.documentElement.dataset.theme = theme
  const look = keptLook(localStorage.getItem(LOOK_KEY))
  if (look) document.documentElement.dataset.look = look
} catch {}
