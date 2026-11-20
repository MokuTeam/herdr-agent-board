// A thread's verification in the panel's head (#492, docs/design/threads 3.8): on or off (and
// whether its lane turned it on), the acceptance lines, the verifier running or awaited while a
// done is held, and the last verdict. Nothing for a thread that never had verification.
import { useEffect } from 'react'
import { type ThreadHead, whenText } from '../../../../src/core/work-threads.ts'
import { useT } from '../../i18n/I18nProvider.tsx'

/** Its sheet (web/styles/verify.css), linked the first time a verification shows: a page without one loads what it did. */
export function linkVerifySheet(doc: Document = document): void {
  if (doc.getElementById('verify-css')) return
  const link = doc.createElement('link')
  link.id = 'verify-css'
  link.rel = 'stylesheet'
  link.href = 'styles/verify.css'
  const look = doc.querySelector('link[href$="look-terminal.css"]')
  if (look?.parentNode) look.parentNode.insertBefore(link, look)
  else doc.head.append(link)
}

export function ThreadVerify({ head }: { head: ThreadHead }) {
  const t = useT()
  const v = head.verify
  const shown = !!v && (v.on || v.accept.length > 0 || !!v.last)
  useEffect(() => {
    if (shown) linkVerifySheet()
  }, [shown])
  if (!v || !shown) return null
  const held = head.proposed?.verify === true
  return (
    <div className="wt-verify" data-on={v.on ? 'true' : 'false'}>
      <p className="wt-verify-head">
        <b>{t(v.on ? 'wt.verify.on' : 'wt.verify.off')}</b>
        {v.lane && <span className="wt-verify-meta"> · {t('wt.verify.lane')}</span>}
        {v.last && (
          <span className="wt-verify-meta"> · {t('wt.verify.last', { verdict: t(`wt.verdict.${v.last}`) })}</span>
        )}
        {v.fails > 0 && <span className="wt-verify-meta"> · {t('wt.verify.fails', { n: v.fails })}</span>}
      </p>
      {v.accept.length ? (
        <ul className="wt-verify-accept" aria-label={t('wt.verify.accept')}>
          {v.accept.map(a => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : (
        v.on && <p className="wt-verify-meta">{t('wt.verify.none')}</p>
      )}
      {held && (
        <p className="wt-verify-run">
          {v.run
            ? t('wt.verify.running', { name: v.run.name, until: whenText(v.run.until, Date.now()) })
            : t('wt.verify.waiting')}
        </p>
      )}
    </div>
  )
}
