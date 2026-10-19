// The list the setup note opens, anchored to it: what is set up and what is not, what each
// missing piece costs and how to fix it, commands to copy (hooks/useSetupNote.ts keeps its state).
// Optional pieces that are off (herdr-wake, desktop notifications) are listed but never raise the note.
import type { ReactNode } from 'react'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { problems, type SetupLevel, setupList } from '../models/setup.ts'

// The page's markup as it was: the row's mark is aria-hidden, the copy button has its label.
const Svg = ({ children }: { children: ReactNode }) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: the page's markup as it was; the row's text or the button's label names it
  <svg viewBox="0 0 20 20">{children}</svg>
)
const Check = () => (
  <Svg>
    <path d="m5 10.5 3.2 3.2L15 7" />
  </Svg>
)
const Bang = () => (
  <Svg>
    <path d="M10 5.5v5.5M10 14.2v.3" />
  </Svg>
)
const Dot = () => (
  <Svg>
    <circle cx="10" cy="10" r="2.2" />
  </Svg>
)
const CopyIcon = () => (
  <Svg>
    <rect x="7" y="7" width="9" height="9" rx="2" />
    <path d="M13 4.5H6A1.5 1.5 0 0 0 4.5 6v7" />
  </Svg>
)
const MARK: Record<SetupLevel, () => ReactNode> = { ok: Check, warn: Bang, error: Bang, off: Dot, na: Dot }

function Code({ text, index, setup }: { text: string; index: number; setup: SetupNoteState }) {
  const t = useT()
  const done = setup.copied.has(index)
  return (
    <div className="setup-code">
      <pre>{text}</pre>
      <button
        className={done ? 'setup-copy done' : 'setup-copy'}
        type="button"
        data-copy={index}
        aria-label={t(done ? 'setup.copied' : 'setup.copy')}
        title={t('setup.copy')}
        onClick={() => setup.copy(index, text)}
      >
        {done ? <Check /> : <CopyIcon />}
      </button>
    </div>
  )
}

function List({ setup }: { setup: SetupNoteState }) {
  const t = useT()
  const { common, rows } = setupList(setup.checks ?? [])
  // The commands on show, numbered in order for their copy buttons.
  let copies = 0
  const code = (text: string) => <Code text={text} index={copies++} setup={setup} />
  const top = common && (
    <div className="setup-common">
      <p>{common.fix}</p>
      {code(common.code)}
    </div>
  )
  const items = rows.map(({ check: c, problem, fix, code: own }) => {
    const Mark = MARK[c.level]
    return (
      <li className="setup-row" data-level={c.level} key={c.id}>
        <span className="setup-mark" aria-hidden="true">
          <Mark />
        </span>
        <span className="sr-only">{`${t(`setup.level.${c.level}`)}: `}</span>
        <div className="setup-text">
          <b>{c.title}</b>
          {c.detail && (problem ? <p>{c.detail}</p> : <span className="setup-quiet">{` · ${c.detail}`}</span>)}
          {fix && <p className="setup-fix">{c.fix}</p>}
          {own && code(c.code)}
        </div>
      </li>
    )
  })
  return (
    <>
      {top}
      <ul className="setup-list">{items}</ul>
    </>
  )
}

export function SetupPop({ setup }: { setup: SetupNoteState }) {
  const t = useT()
  const n = problems(setup.checks ?? [])
  const failed = setup.loadFailed && <p className="setup-sum setup-failed">{t('setup.loadFailed')}</p>
  return (
    <div
      className="setup-pop"
      id="setup-pop"
      role="dialog"
      aria-labelledby="setup-title"
      tabIndex={-1}
      hidden={setup.hidden}
      ref={setup.popRef}
    >
      <header>
        <h3 id="setup-title">{t('setup.title')}</h3>
        <button
          className="icon-button"
          id="setup-close"
          type="button"
          aria-label={t('sheet.closeLabel')}
          onClick={() => setup.close(true)}
        >
          ×
        </button>
      </header>
      <div id="setup-content">
        {!setup.opened ? null : setup.checks ? (
          <>
            {failed}
            <p className="setup-sum">{n ? t('setup.todo', { n }) : t('setup.allSet')}</p>
            <List setup={setup} />
          </>
        ) : (
          failed || <p className="setup-sum">{t('setup.checking')}</p>
        )}
      </div>
      <footer className="setup-foot">
        <button className="button" type="button" data-setup="recheck" disabled={setup.loading} onClick={setup.recheck}>
          {t(setup.busy ? 'setup.checking' : 'setup.recheck')}
        </button>
        <button
          className="button plain"
          type="button"
          data-setup="hide"
          hidden={setup.opened && !setup.summary?.todo}
          onClick={setup.hide}
        >
          {t('setup.hide')}
        </button>
      </footer>
      <p className="setup-cli">{t('setup.cli')}</p>
    </div>
  )
}
