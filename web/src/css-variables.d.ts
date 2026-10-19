// CSS custom properties in `style` (the stylesheets read e.g. `--c` for a column's dot color).
import 'react'

declare module 'react' {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined
  }
}
