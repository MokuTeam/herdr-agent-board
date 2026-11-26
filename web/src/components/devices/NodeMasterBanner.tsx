// Quiet banner on a node's local web board (#744), and one-time redirect to the master's
// public board URL on load when the master is online with a URL and `?local=1` was not asked,
// with the page's deep link (#837: a thread's link, a notification's session) along.
// Until the payload comes (never, in a tab in the background) the master is the one the node put in
// the page itself (#797, core/node-master-page.ts).
import { useEffect, useRef, useState } from 'react'
import { NODE_MASTER_META, nodeMasterOfMeta } from '../../../../src/core/node-master-page.ts'
import type { NodeMasterPayload } from '../../../../src/core/payload.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { nodeMasterAction, type OpenedAt, readStayLocal, type SessionStore } from '../../models/node-master.ts'
import { remotePage } from '../../models/remote-page.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'

export interface NodeMasterBannerProps {
  /** Override for tests: defaults to `url => window.location.replace(url)`. */
  navigate?: ((url: string) => void) | undefined
  /** Override for tests: defaults to `location.search`. */
  search?: string
  /** Override for tests: defaults to `sessionStorage`. */
  sessionStore?: SessionStore | null
  /** Override for tests: defaults to the master the node put in the page (#797). */
  pageMaster?: NodeMasterPayload | null
  /** Override for tests: defaults to `location` as the page was opened (#837). */
  opened?: OpenedAt | null | undefined
}

/**
 * The address the page was opened at, read on the first render: the page forgets its hash once the
 * board is in (hooks/useReveal.ts, hooks/useThreadLinks.ts), which may be before the redirect.
 */
function openedAt(): OpenedAt | null {
  return typeof location === 'undefined' ? null : { pathname: location.pathname, hash: location.hash }
}

/** The master a node put in its page (#797), or null: any other board's page has none. */
function masterOfPage(): NodeMasterPayload | null {
  if (typeof document === 'undefined') return null
  return nodeMasterOfMeta(document.querySelector(`meta[name="${NODE_MASTER_META}"]`)?.getAttribute('content'))
}

const defaultNavigate = (url: string): void => {
  if (typeof window !== 'undefined') window.location.replace(url)
}

export function NodeMasterBanner({
  navigate = defaultNavigate,
  search,
  sessionStore,
  pageMaster,
  opened,
}: NodeMasterBannerProps) {
  const t = useT()
  const { data } = useBoardContext()
  const remote = remotePage()
  const [fromPage] = useState(() => (pageMaster === undefined ? masterOfPage() : pageMaster))
  const [openedOnLoad] = useState(() => (opened === undefined ? openedAt() : opened))
  // The payload's once it came; before that, the page's.
  const nodeMaster = data ? data.nodeMaster : (fromPage ?? undefined)
  const decidedRef = useRef(false)
  const [stayBanner, setStayBanner] = useState(false)

  useEffect(() => {
    if (remote || !nodeMaster || decidedRef.current) return
    decidedRef.current = true
    const stayLocal = readStayLocal(search, sessionStore)
    const initial = nodeMasterAction(nodeMaster, { remote, stayLocal, opened: openedOnLoad })
    if (initial?.kind === 'redirect') {
      navigate(initial.url)
      return
    }
    setStayBanner(true)
  }, [remote, nodeMaster, search, sessionStore, navigate, openedOnLoad])

  if (remote || !nodeMaster || !stayBanner) return null

  const action = nodeMasterAction(nodeMaster, { remote, stayLocal: true })
  if (!action || action.kind === 'redirect') return null

  return (
    <p id="node-master-banner" className={classNames('node-master-banner', action.offline && 'offline')} role="status">
      <span>{t('node.banner.text', { id: action.nodeId, name: action.masterName })}</span>
      {action.offline && <span className="node-master-banner-note"> · {t('node.banner.offline')}</span>}
      {action.url && (
        <a className="node-master-banner-link" href={action.url}>
          {t('node.banner.open')}
        </a>
      )}
    </p>
  )
}
