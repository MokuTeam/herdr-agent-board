// The helpers window (the old page's helpers.js root): its head with what is on show (the list,
// or a helper's kind, title, what it is and how it stands), the list of the session's helpers or
// one helper's conversation drawn as the session's is, and a footer of counts and times. It lives
// in <body> beside the page (hooks/useModalFocus.ts); its motion, reads, focus and keys are
// hooks/useHelpers.ts's. A redraw of the body keeps the focus on what opens the same thing
// (hooks/useKeepFocus.ts).
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PublicHelper, WorkflowRun } from '../../../../src/core/helpers.ts'
import type { Item, Translator } from '../../../../src/core/types.ts'
import type { HelperRef, HelpersEngine, HelpersRefs, HelpersView, SheetSide } from '../../hooks/useHelpers.ts'
import { useKeepFocus } from '../../hooks/useKeepFocus.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { clock, groupHelpers, helperTitle, tokens, toneOf, took } from '../../models/helper-model.ts'
import { reducedMotion } from '../../models/spring.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { useStore } from '../../state/store.ts'
import { Thread } from '../sheet/Thread.tsx'
import type { ThreadLinks } from '../sheet/ThreadLinks.tsx'
import { HelperIcon } from './glyphs.tsx'
import { HelperRow, KindIcon, Since, StatusMark } from './HelperRows.tsx'

export interface HelpersHandlers {
  close(): void
  back(): void
  /** A helper of the session over what is on show. */
  helper(id: string): void
  /** The list at a workflow run's agents. */
  run(id: string): void
  /** Another session: the window closes, it opens. */
  session(key: string): void
  scrolled(): void
}

export interface HelpersWindowViewProps {
  view: HelpersView
  /** The open sheet's session and detail. */
  sheet: SheetSide
  /** The session whose helpers these are. */
  item: Item | undefined
  /** The board's sessions. */
  items: readonly Item[]
  refs?: Partial<HelpersRefs>
  on?: Partial<HelpersHandlers>
}

/** What the head says of a helper before its own answer came: what the sheet knows, else its id. */
type HeadHelper = Partial<Omit<PublicHelper, 'status'>> & { id: string; kind: string; status: string }

const isList = (ref: HelperRef | undefined): ref is { list: true; run: string | null } => !!ref && 'list' in ref

/** The helper on show: as read, else as the sheet knows it, else only its id. */
function shownHelper(view: HelpersView, detail: SessionDetailLike | null, id: string): HeadHelper {
  return view.data?.helper ?? (detail?.helpers ?? []).find(h => h.id === id) ?? { id, kind: 'agent', status: '' }
}

type SessionDetailLike = { helpers?: PublicHelper[] | undefined; workflows?: WorkflowRun[] | undefined }

function subOf(h: HeadHelper, t: Translator): string {
  const title = helperTitle(h)
  return [
    t(`helpers.kind.${h.kind}`),
    h.name && h.name !== title ? h.name : '',
    h.type,
    h.model,
    h.phase && t('helpers.phase', { phase: h.phase }),
    h.kind === 'teammate' ? '' : t(h.background ? 'helpers.background' : 'helpers.foreground'),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function HelpersWindowView({ view, sheet, item, items, refs = {}, on = {} }: HelpersWindowViewProps) {
  const t = useT()
  const keepFocus = useKeepFocus()
  const top = view.stack.at(-1)
  const detail = sheet.key === view.key ? sheet.data : null
  const label = (key: string) => ({ title: t(key), 'aria-label': t(key) })
  const helper = !view.hidden && top && !isList(top) ? shownHelper(view, detail, top.id) : null
  const status = helper?.status ?? ''
  return (
    <div className="ql helpers" hidden={view.hidden} ref={refs.layer}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dimmed board around it closes it with a click; Esc does with keys */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div className="ql-scrim" ref={refs.scrim} onClick={() => on.close?.()} />
      <section
        className="ql-win helper-win"
        role="dialog"
        aria-modal="true"
        aria-labelledby="helper-name"
        tabIndex={-1}
        ref={refs.win}
      >
        <header className="ql-head helper-head">
          <button
            type="button"
            className="icon-button ql-back helper-back"
            hidden={view.stack.length < 2}
            {...label('helpers.back')}
            onClick={() => on.back?.()}
          >
            <HelperIcon name="back" />
          </button>
          <span className="ql-icon helper-icon">
            {helper ? <KindIcon kind={helper.kind} color={helper.color} /> : top && <HelperIcon name="stack" />}
          </span>
          <div className="ql-titles">
            <h3 id="helper-name">
              {helper ? helperTitle(helper) : top ? t('helpers.listTitle', { name: item?.name ?? '' }) : ''}
            </h3>
            <p className="helper-sub">{helper ? subOf(helper, t) : ''}</p>
          </div>
          <div className="ql-tools">
            {/* A live region: its words change only with the status, so it is not announced on every read. */}
            <span className="helper-state" role="status" data-tone={status ? toneOf(status) : ''}>
              {status && (
                <>
                  <StatusMark status={status} />
                  <span>{t(`helpers.status.${status}`)}</span>
                </>
              )}
            </span>
          </div>
          <button
            type="button"
            className="icon-button ql-close helper-x"
            {...label('sheet.close')}
            onClick={() => on.close?.()}
          >
            <HelperIcon name="close" />
          </button>
        </header>
        <div
          className={isList(top) ? 'ql-body helper-body k-list' : 'ql-body helper-body'}
          ref={refs.body}
          onScroll={() => on.scrolled?.()}
          {...keepFocus}
        >
          {view.hidden || !top ? null : isList(top) ? (
            <HelperList detail={detail} on={on} />
          ) : (
            <HelperBody view={view} kind={helper?.kind ?? 'agent'} item={item} items={items} detail={detail} on={on} />
          )}
        </div>
        <footer className="ql-foot helper-foot">
          {view.hidden || !top ? null : isList(top) ? listFoot(detail, t) : <HelperFoot view={view} t={t} />}
        </footer>
      </section>
    </div>
  )
}

/** A section of the list, when it has rows. */
function Section({ title, run, children }: { title: string; run?: string; children: ReactNode[] }) {
  if (!children.length) return null
  return (
    <section className="helper-section" data-run={run}>
      <h4>{title}</h4>
      <div className="helper-rows">{children}</div>
    </section>
  )
}

/** Every helper of the session: at work, the workflow runs with their agents, the teammates, the finished. */
function HelperList({ detail, on }: { detail: SessionDetailLike | null; on: Partial<HelpersHandlers> }) {
  const t = useT()
  if (!detail) return <div className="ql-wait">{t('loading')}</div>
  const g = groupHelpers(detail.helpers ?? [], detail.workflows ?? [])
  const row = (h: PublicHelper & { depth?: number }) => <HelperRow key={h.id} h={h} onOpen={() => on.helper?.(h.id)} />
  const sections = [
    <Section key="running" title={t('helpers.section.running')}>
      {g.running.map(row)}
    </Section>,
    ...g.runs.map(run => {
      const stats = [
        run.agents.length && t('helpers.agents', { n: run.agents.length }),
        run.tokens && t('helpers.tokens', { n: tokens(run.tokens) }),
        run.summary,
      ]
        .filter(Boolean)
        .join(' · ')
      return (
        <Section key={`run-${run.id}`} title={`${t('helpers.kind.run')} · ${run.name || run.id}`} run={run.id}>
          {[
            <div key="run" className="helper-run" data-status={run.status}>
              <StatusMark status={run.status} />
              <span>{stats || t(`helpers.status.${run.status}`)}</span>
            </div>,
            ...run.agents.map(row),
          ]}
        </Section>
      )
    }),
    <Section key="teammates" title={t('helpers.section.teammates')}>
      {g.teammates.map(row)}
    </Section>,
    <Section key="finished" title={t('helpers.section.finished')}>
      {g.finished.map(row)}
    </Section>,
  ]
  if (!g.running.length && !g.runs.length && !g.teammates.length && !g.finished.length)
    return (
      <div className="ql-empty">
        <HelperIcon name="stack" />
        <p>{t('helpers.none')}</p>
      </div>
    )
  return <>{sections}</>
}

function listFoot(detail: SessionDetailLike | null, t: Translator): string {
  if (!detail) return ''
  const all = detail.helpers?.length ?? 0
  const running = (detail.helpers ?? []).filter(h => h.status === 'running').length
  const runs = detail.workflows?.length ?? 0
  return [
    t('helpers.count', { n: all }),
    running && t('helpers.running', { n: running }),
    runs && t('helpers.runs', { n: runs }),
  ]
    .filter(Boolean)
    .join(' · ')
}

interface HelperBodyProps {
  view: HelpersView
  kind: string
  item: Item | undefined
  items: readonly Item[]
  detail: SessionDetailLike | null
  on: Partial<HelpersHandlers>
}

/** One helper's conversation, drawn as the session's is: what the session asked it is the other side. */
function HelperBody({ view, kind, item, items, detail, on }: HelperBodyProps) {
  const t = useT()
  const d = view.data
  if (!d) {
    if (!view.error) return <div className="ql-wait">{t('loading')}</div>
    return (
      <div className="ql-empty">
        <HelperIcon name="stack" />
        <p>{view.error}</p>
      </div>
    )
  }
  if (!d.conversation.length)
    return (
      <div className="ql-empty">
        <HelperIcon name={kind} />
        <p>{t('thread.empty')}</p>
      </div>
    )
  const links: ThreadLinks = {
    helpers: detail?.helpers ?? [],
    workflows: detail?.workflows ?? [],
    items,
    onHelper: id => on.helper?.(id),
    onRun: id => on.run?.(id),
    onSession: key => on.session?.(key),
  }
  return (
    <div className="thread helper-thread">
      <Thread conversation={d.conversation} item={item ?? {}} links={links} helper={d.helper} />
    </div>
  )
}

/** How long it ran (a clock while it runs), its tool calls and tokens, when it started. */
function HelperFoot({ view, t }: { view: HelpersView; t: Translator }) {
  const h = view.data?.helper
  if (!h) return null
  const time = took(h)
  const parts: ReactNode[] = [
    h.status === 'running'
      ? h.startedAt && <Since key="since" at={h.startedAt} />
      : time != null && t('helpers.took', { time: clock(time) }),
    h.tools ? t('helpers.tools', { n: h.tools }) : '',
    h.tokens ? t('helpers.tokens', { n: tokens(h.tokens) }) : '',
    h.startedAt
      ? t('helpers.started', {
          time: new Date(h.startedAt).toLocaleString(t.lang, { dateStyle: 'short', timeStyle: 'short' }),
        })
      : '',
  ].filter(Boolean)
  return parts.flatMap((part, n) => (n ? [' · ', part] : [part]))
}

/** The page's helpers window, in <body> beside the page. */
export function HelpersWindow({
  engine,
  upgrade,
}: {
  engine: HelpersEngine
  upgrade?: (root: HTMLElement, cwd: string) => void
}) {
  const view = useStore(engine.view)
  const sheet = useStore(engine.sheet)
  const { data } = useBoardContext()
  const { refs } = engine
  const item = view.key ? data?.items.find(i => i.key === view.key) : undefined
  const top = view.stack.at(-1)
  // Just opened: drawn now, it grows out of where it came from.
  useLayoutEffect(() => engine.grow())
  // A helper's conversation read again: at its end it stays at its end. Its paths become chips when
  // it is drawn anew: on show, and when it changed (a read while it works often brings the same).
  const upgraded = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new answer is when to look, not what it reads
  useLayoutEffect(() => {
    const body = refs.body.current
    if (!body || !view.data) return
    if (view.first || engine.pinned()) body.scrollTop = body.scrollHeight
    // What the drawn thread depends on: its turns, and its status (whether its last call is live).
    const drawn = JSON.stringify([view.data.helper.status, view.data.conversation])
    if (!view.first && drawn === upgraded.current) return
    upgraded.current = drawn
    upgrade?.(body, item?.cwd ?? '')
  }, [view.data])
  // The list opened at a workflow run: scrolled to it once, with a glint; a later draw keeps the reader's place.
  const detail = sheet.key === view.key ? sheet.data : null
  useLayoutEffect(() => {
    const body = refs.body.current
    if (!body || !isList(top) || !top.run || !detail) return
    const sec = body.querySelector<HTMLElement>(`[data-run="${CSS.escape(top.run)}"]`)
    top.run = null
    if (sec)
      requestAnimationFrame(() => {
        sec.scrollIntoView({ block: 'start' })
        if (!reducedMotion.matches)
          sec.animate(
            [{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }, { background: 'transparent' }],
            { duration: 1400, easing: 'ease-out' },
          )
      })
  }, [top, detail, refs])
  if (typeof document === 'undefined') return null
  return createPortal(
    <HelpersWindowView
      view={view}
      sheet={sheet}
      item={item}
      items={data?.items ?? []}
      refs={refs}
      on={{
        close: engine.close,
        back: engine.back,
        helper: engine.pushHelper,
        run: engine.pushRun,
        session: engine.session,
        scrolled: engine.scrolled,
      }}
    />,
    document.body,
  )
}
