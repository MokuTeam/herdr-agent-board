// The device of a card or sheet (#502, #758, docs/design/nodes 12): an inline device glyph and
// short name in the card's top row beside the age (no extra row, zero height change), and a chip
// with the device's title and offline age in the session sheet's line. A board without remote nodes
// draws none of it.
import { useT } from '../../i18n/I18nProvider.tsx'
import type { NodeLook } from '../../models/devices.ts'
import { classNames } from '../class-names.ts'
import { DeviceGlyph } from '../icons.tsx'

/** The chip alone: the session sheet's head. */
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

/** Quiet inline machine label inside `.card-top` (#758): muted device glyph + short name. */
export function CardDevice({ node }: { node: NodeLook }) {
  const t = useT()
  return (
    <span
      className={classNames('card-device', node.offline && 'offline')}
      title={node.why || t('node.on', { name: node.title })}
    >
      <DeviceGlyph />
      <span className="card-device-name">{node.title}</span>
    </span>
  )
}
