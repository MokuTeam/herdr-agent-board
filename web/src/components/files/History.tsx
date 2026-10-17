// The past sessions of a session's project in the quick look (the old page's files.js
// showHistory, hits, openHit): a search field, then the hits with the session's own title, who
// wrote it and when; a hit opens to the whole message, rendered, and folds back. The query and
// the hits stay on the quick look's step, so a step back from a file finds them again.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { dateText, excerptOf, markParts } from '../../models/files.ts'
import { markdown } from '../../models/markdown.ts'
import { type HistoryHit, idOf, type LookTarget } from '../../models/quick-look.ts'
import { classNames } from '../class-names.ts'
import { FileIcon } from './FileChip.tsx'
import { LookEmpty } from './Preview.tsx'

type HistoryTarget = Extract<LookTarget, { kind: 'history' }>

/** What the footer says under the hits. */
export function historyFoot(target: HistoryTarget, t: Translator): string {
  const d = target.result
  if (!d || 'loading' in d || d.unavailable || !d.results?.length) return ''
  return [t('history.results', { n: d.results.length }), d.truncated ? t('history.limited') : '']
    .filter(Boolean)
    .join(' · ')
}

export interface HistoryProps {
  target: HistoryTarget
  /** The query submitted (trimmed). */
  onSearch?: ((query: string) => void) | undefined
  /** A hit opened: its paths become chips. */
  upgrade?: ((root: HTMLElement, cwd: string) => void) | undefined
}

export function History({ target, onSearch, upgrade }: HistoryProps) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <>
      <form
        className="ql-search"
        onSubmit={e => {
          e.preventDefault()
          onSearch?.(input.current?.value.trim() ?? '')
        }}
      >
        <FileIcon name="search" />
        <input
          ref={input}
          type="search"
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('history.placeholder')}
          aria-label={t('history.placeholder')}
          defaultValue={target.query ?? ''}
        />
      </form>
      <div className="ql-hits">
        {/* A new search draws its hits afresh, all folded. */}
        <Hits key={target.result ? idOf(target.result) : 0} target={target} upgrade={upgrade} />
      </div>
    </>
  )
}

function Hits({ target, upgrade }: Pick<HistoryProps, 'target' | 'upgrade'>) {
  const t = useT()
  const d = target.result
  if (!d) return <p className="ql-dnote">{t('history.prompt')}</p>
  if ('loading' in d) return <p className="ql-dnote">{t('loading')}</p>
  if (d.unavailable) return <LookEmpty icon="history" text={t('history.unavailable')} />
  if (!d.results?.length) return <LookEmpty icon="search" text={t('history.empty')} />
  return d.results.map((hit, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the hits in the order found; a new search draws them anew
    <Hit key={i} hit={hit} i={i} query={target.query} cwd={target.cwd} upgrade={upgrade} />
  ))
}

interface HitProps {
  hit: HistoryHit
  i: number
  query: string | undefined
  cwd: string
  upgrade?: ((root: HTMLElement, cwd: string) => void) | undefined
}

/** A hit: who and when, the excerpt with the query marked; opened, the whole message. */
function Hit({ hit, i, query, cwd, upgrade }: HitProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // The whole message is drawn the first time it opens, then kept.
  const [drawn, setDrawn] = useState(false)
  const full = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn is when its paths are new
  useLayoutEffect(() => {
    if (drawn && full.current) upgrade?.(full.current, cwd)
  }, [drawn])
  const toggle = () => {
    setOpen(was => !was)
    setDrawn(true)
  }
  const excerpt = excerptOf(hit)
  return (
    <article
      className={classNames('ql-hit', open && 'open')}
      data-hit={i}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a hit opens with Enter or Space, as a button would
      tabIndex={0}
      onClick={e => {
        if (!(e.target instanceof Element && e.target.closest('[data-fs], a'))) toggle()
      }}
      onKeyDown={e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          toggle()
        }
      }}
    >
      <header>
        <span className={`who ${hit.role === 'user' ? 'you' : 'agent'}`}>
          {t(hit.role === 'user' ? 'history.you' : 'history.agent')}
        </span>
        <b>{hit.title || hit.session.slice(0, 8)}</b>
        <time>{hit.date ? dateText(Date.parse(hit.date), t.lang) : t('history.unknownDate')}</time>
      </header>
      <p className="ex" hidden={open}>
        {excerpt.cut && '…'}
        {markParts(excerpt.text, query).map((part, n) =>
          // biome-ignore lint/suspicious/noArrayIndexKey: the excerpt's parts in their order
          part.hit ? <mark key={n}>{part.text}</mark> : part.text,
        )}
      </p>
      {drawn && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
        <div ref={full} className="full md" hidden={!open} dangerouslySetInnerHTML={{ __html: markdown(hit.text) }} />
      )}
    </article>
  )
}
