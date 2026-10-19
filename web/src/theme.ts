// The viewer's choice of light or dark (Settings), before the page paints, so it never flashes
// the other one. Without a choice the page follows the system. Kept in this browser. The server
// bundles it as theme.js (server/web-bundle.ts), which web/index.html loads ahead of the styles.
import { keptTheme, THEME_KEY } from './models/theme.ts'

try {
  const theme = keptTheme(localStorage.getItem(THEME_KEY))
  if (theme) document.documentElement.dataset.theme = theme
} catch {}
