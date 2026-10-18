// The column titles above the lanes, with the count of cards in the lanes on show; a column with
// no card on show narrows to its head (hooks/useColumnWidths.ts), quieter.
import type { ColumnHead } from '../models/toolbar.ts'

export function ColumnsHead({ heads }: { heads: ColumnHead[] }) {
  return (
    <div className="columns-head" id="columns-head">
      {heads.map(c => (
        <div className={c.vacant ? 'col-head vacant' : 'col-head'} key={c.id}>
          <span className="dot" style={{ '--c': c.color }} />
          <span className="t">{c.title}</span>
          <span className="n">{c.n}</span>
        </div>
      ))}
    </div>
  )
}
