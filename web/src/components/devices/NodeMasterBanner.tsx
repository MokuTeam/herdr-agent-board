// Quiet banner on a node's local web board (#744), and one-time redirect to the master's
// public board URL on load when the master is online with a URL and `?local=1` was not asked.
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { nodeMasterAction, readStayLocal, type SessionStore } from '../../models/node-master.ts'
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
}

const defaultNavigate = (url: string): void => {
  if (typeof window !== 'undefined') window.location.replace(url)
}

export function NodeMasterBanner({ navigate = defaultNavigate, search, sessionStore }: NodeMasterBannerProps) {
  const t = useT()
  const { data } = useBoardContext()
  const remote = remotePage()
  const nodeMaster = data?.nodeMaster
  const decidedRef = useRef(false)
  const [stayBanner, setStayBanner] = useState(false)

  useEffect(() => {
    if (remote || !nodeMaster || decidedRef.current) return
    decidedRef.current = true
    const stayLocal = readStayLocal(search, sessionStore)
    const initial = nodeMasterAction(nodeMaster, { remote, stayLocal })
    if (initial?.kind === 'redirect') {
      navigate(initial.url)
      return
    }
    setStayBanner(true)
  }, [remote, nodeMaster, search, sessionStore, navigate])

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
