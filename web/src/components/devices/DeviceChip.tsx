// The device of a card or sheet (#502, #758, docs/design/nodes 12): on a card, a small
// coloured top-left corner with zero text and zero height impact ("Agent on <name>" / "Агент на
// <name>" on hover and keyboard focus); in the session sheet's line, a chip with the device's
// title and offline age (so touch users see the machine name there). A board without remote nodes
// draws none of it.
import { useT } from '../../i18n/I18nProvider.tsx'
import type { NodeLook } from '../../models/devices.ts'
import { classNames } from '../class-names.ts'

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

/**
 * Subtle coloured top-left corner on a card (#758): zero text, zero height impact; hover or
 * keyboard focus shows "Agent on <name>" / "Агент на <name>" (or offline reason), and
 * aria-label carries the machine name so colour is never the only carrier.
 */
export function CardDeviceCorner({ node }: { node: NodeLook }) {
  const t = useT()
  const label = node.why || t('node.agentOn', { name: node.title })
  return (
    <span
      className={classNames('card-device-corner', node.offline && 'offline')}
      style={{ '--device': node.color }}
      role="img"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can focus the corner to read which machine runs the card
      tabIndex={0}
      aria-label={label}
      title={label}
      data-tip={label}
    />
  )
}
