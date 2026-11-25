// The device of a card or sheet (#502, #758, docs/design/nodes 12): on a card, a small
// coloured top-left corner with zero text and zero height impact ("Agent on <name>" / "Агент на
// <name>" on hover and keyboard focus); in the session sheet's line, a chip with the device's
// title and offline age (so touch users see the machine name there). A board without remote nodes
// draws none of it.
import { type DeviceMarker, markerClasses, markerOrDefault } from '../../../../src/core/device-marker.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { NodeLook } from '../../models/devices.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
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
 * The machine marker on a card (#758, #789): by default a subtle coloured bottom-right corner, else
 * as Settings, Devices set it (`deviceMarker`: the corner elsewhere or bigger, a thin stripe along a
 * side, or none). Zero text, zero height impact; hover or keyboard focus shows "Agent on <name>" /
 * "Агент на <name>" (or the offline reason), and aria-label carries the machine name so colour is
 * never the only carrier.
 */
export function CardDeviceCorner({ node }: { node: NodeLook }) {
  const { data } = useBoardContext()
  return <DeviceMarkerMark node={node} marker={markerOrDefault(data?.deviceMarker)} />
}

/** The marker itself, for a given marker: the card's, and the preview in Settings, Devices. */
export function DeviceMarkerMark({
  node,
  marker,
  preview,
}: {
  node: NodeLook
  marker: DeviceMarker
  preview?: boolean
}) {
  const t = useT()
  const classes = markerClasses(marker)
  if (!classes) return null
  const label = node.why || t('node.agentOn', { name: node.title })
  if (preview) return <span className={classNames(...classes)} style={{ '--device': node.color }} aria-hidden="true" />
  return (
    <span
      className={classNames(...classes, node.offline && 'offline')}
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
