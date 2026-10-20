// One item of a context menu: its check (when the menu has a check column), a lane's or a
// column's color, the label and, when it is gray, why; a choice's count (a folded toolbar
// control's, as its segment shows it); a submenu's chevron or a key hint.
import type { MenuItem as MenuItemModel } from '../../models/menu-model.ts'
import { classNames } from '../class-names.ts'
import { CheckIcon, ChevIcon } from '../icons.tsx'

export interface MenuItemProps {
  item: MenuItemModel
  /** `<menu id>-<index>`, for the menu's aria-activedescendant. */
  id: string
  index: number
  /** The menu has a check column. */
  checks: boolean
  /** Lit by the pointer or the keys. */
  active: boolean
  /** Its submenu is open. */
  expanded: boolean
}

export function MenuItem({ item, id, index, checks, active, expanded }: MenuItemProps) {
  const checkbox = item.checked !== undefined
  const color = item.swatch || item.dot
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked only with the role menuitemcheckbox, as before
    <div
      className={classNames('menu-item', item.danger && 'danger', active && 'active')}
      id={id}
      role={checkbox ? 'menuitemcheckbox' : 'menuitem'}
      data-i={index}
      aria-disabled={item.disabled ? true : undefined}
      aria-checked={checkbox ? !!item.checked : undefined}
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? expanded : undefined}
    >
      {checks && <span className="mi-check">{item.checked && <CheckIcon />}</span>}
      {color && <span className={classNames('mi-dot', !!item.dot && 'round')} style={{ '--dot': color }} />}
      <span className="mi-text">
        <span className="mi-label">{item.label}</span>
        {item.reason && <span className="mi-reason">{item.reason}</span>}
      </span>
      {item.count !== undefined && (
        <span
          className={classNames('mi-count', item.tint !== undefined && 'tint')}
          style={item.tint ? { '--c': item.tint } : undefined}
        >
          {item.count}
        </span>
      )}
      {item.submenu ? (
        <span className="mi-chev">
          <ChevIcon />
        </span>
      ) : (
        item.hint && <span className="mi-hint">{item.hint}</span>
      )}
    </div>
  )
}
