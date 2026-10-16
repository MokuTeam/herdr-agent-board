// The column titles above the lanes, with the count of cards in the lanes on show.
import type { ColumnHead } from '../models/toolbar.ts'

export function ColumnsHead({ heads }: { heads: ColumnHead[] }) {
  return (
    <div className="columns-head" id="columns-head">
      {heads.map(c => (
        <div className="col-head" key={c.id}>
          <span className="dot" style={{ '--c': c.color }} />
          {c.title}
          <span className="n">{c.n}</span>
        </div>
      ))}
    </div>
  )
}
