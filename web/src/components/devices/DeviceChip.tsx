// The device of a card of another device (#502, docs/design/nodes 12): a small chip with the device's
// title, in a row of its own under the card's name row, so it never takes the name's room in the
// compact and the phone layouts. That row is the card's identity row (#141 adds the pane and the
// profile to it): the chip goes there, not into a second one. An offline device's cards say how
// old they are beside it. A card of this computer has no `device` and no row: it draws as before.
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type NodeLook, nodeLook } from '../../models/devices.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'

/** The chip alone: the card's row, the launch card's and the session sheet's head. */
export function DeviceChip({ node }: { node: NodeLook }) {
  const t = useT()
  return (
    <span
      className={classNames('device-chip', node.offline && 'offline')}
      title={node.why || t('node.on', { name: node.title })}
    >
      <span className="device-dot" aria-hidden="true" />
      <span className="device-title">{node.title}</span>
    </span>
  )
}

/** The chip, and while the device is not heard how old its cards are. */
export function DeviceFacts({ node }: { node: NodeLook }) {
  return (
    <>
      <DeviceChip node={node} />
      {node.offline && <span className="device-as-of">{node.asOf}</span>}
    </>
  )
}

/** A card's identity row with its device; none for a card of this computer. */
export function CardIdentity({ item }: { item: Pick<Item, 'device'> }) {
  const t = useT()
  const { data, now } = useBoardContext()
  const node = nodeLook(item, data?.devices, now, t)
  if (!node) return null
  return (
    <div className="card-ident">
      <DeviceFacts node={node} />
    </div>
  )
}
