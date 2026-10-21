// The column titles above the lanes, with the count of cards in the lanes on show; a column with
// no card on show narrows to its head (hooks/useColumnWidths.ts), quieter. Each names its column
// (data-col): "Idle"'s has a menu (models/board-menus.ts). The one shown alone (`only`, by the
// Terminal style's keys) says so (data-only).
import type { ColumnId } from '../../../src/core/types.ts'
import type { ColumnHead } from '../models/toolbar.ts'

export function ColumnsHead({ heads, only = null }: { heads: ColumnHead[]; only?: ColumnId | null }) {
  return (
    <div className="columns-head" id="columns-head">
      {heads.map(c => (
        <div
          className={c.vacant ? 'col-head vacant' : 'col-head'}
          key={c.id}
          data-col={c.id}
          data-only={c.id === only ? '' : undefined}
        >
          <span className="dot" style={{ '--c': c.color }} />
          <span className="t">{c.title}</span>
          <span className="n">{c.n}</span>
        </div>
      ))}
    </div>
  )
}
