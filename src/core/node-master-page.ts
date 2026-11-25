// A node's page carries its master in the page itself (#797): the redirect to the master's board
// and the banner with its link (web/src/components/devices/NodeMasterBanner.tsx, #744) need the
// master before the board's payload comes, which a browser tab in the background never asks for
// (web/src/api/useBoard.ts suspends while hidden). Only a pure node with a paired master gets the
// tag (server/app.ts); every other board's page goes out as it was. No I/O.
import type { NodeMasterPayload } from './nodes.ts'

/** The meta tag's name. */
export const NODE_MASTER_META = 'board-node-master'

const attr = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** `html` with the master in a meta tag at the end of its head; as it was with none. */
export function pageWithNodeMaster(html: string, master: NodeMasterPayload | null): string {
  if (!master) return html
  const view: NodeMasterPayload = { nodeId: master.nodeId, name: master.name, url: master.url, online: master.online }
  const tag = `<meta name="${NODE_MASTER_META}" content="${attr(JSON.stringify(view))}">`
  return html.includes('</head>') ? html.replace('</head>', () => `  ${tag}\n</head>`) : html
}

/** The meta tag's content as the page reads it back, or null when it is none of that shape. */
export function nodeMasterOfMeta(content: string | null | undefined): NodeMasterPayload | null {
  if (!content) return null
  try {
    const v: unknown = JSON.parse(content)
    if (typeof v !== 'object' || v === null) return null
    const { nodeId, name, url, online } = v as Record<string, unknown>
    if (typeof nodeId !== 'string' || typeof name !== 'string' || typeof online !== 'boolean') return null
    if (url !== null && typeof url !== 'string') return null
    return { nodeId, name, url, online }
  } catch {
    return null
  }
}
