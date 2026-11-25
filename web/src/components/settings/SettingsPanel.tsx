// Structured Settings panel (#651): replaces the 24-item cascading context menu with a calm
// 5-section panel (Display, Board & Agents, Features, Integrations, System) aligned with the
// board's design system. Works docked or floating on desktop, and full-screen with section tabs
// on phone widths. Every existing setting and dedicated sub-panel stays reachable.
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { FOLD_MODES, type FoldMode } from '../../../../src/core/fold-mode.ts'
import { LANGUAGES } from '../../../../src/core/i18n/translator.ts'
import { PRESENCE_MODES, type PresenceMode } from '../../../../src/core/presence.ts'
import { TODO_MODES, type TodoMode, todoModeOf } from '../../../../src/core/todos.ts'
import { THREAD_MODES } from '../../../../src/core/work-threads.ts'
import { api, errorText } from '../../api/client.ts'
import { usePanelPlace } from '../../hooks/usePanelLayout.ts'
import {
  chooseCompact,
  chooseFold,
  chooseLanguage,
  choosePresence,
  chooseTurnResume,
  endLogin,
  type FeatureSetting,
  offersDevices,
  type PresenceSetting,
  type ThreadsSetting,
} from '../../hooks/useSettingsMenu.ts'
import type { SetupNoteState } from '../../hooks/useSetupNote.ts'
import { useLanguage, useT } from '../../i18n/I18nProvider.tsx'
import { backupNoteText } from '../../models/backup.ts'
import { CARD_TEXT_KEY, CARD_TEXTS, type CardText, cardTextNow, setCardText } from '../../models/card-text.ts'
import { reachable } from '../../models/devices.ts'
import { LOOK_KEY, LOOKS, lookNow, setLook } from '../../models/look.ts'
import { masterOwnedNow } from '../../models/master-owned.ts'
import { DOCKS, type Dock } from '../../models/panel-layout.ts'
import { offersProfiles } from '../../models/profiles.ts'
import { adminHere, keptAuth, ownerAdminPage, remotePage } from '../../models/remote-page.ts'
import {
  COMPACT_CHOICES,
  featuresNow,
  offersMokupilot,
  PRESENCE_IDLE_CHOICES,
  threadsNow,
} from '../../models/settings-menu.ts'
import { reducedMotion } from '../../models/spring.ts'
import { offersTeam, teamBadge } from '../../models/team.ts'
import { setTheme, THEME_KEY, THEMES, themeNow } from '../../models/theme.ts'
import { isWakeView, noteShown } from '../../models/wake.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { storage } from '../../state/storage.ts'
import { classNames } from '../class-names.ts'
import { ChevIcon, CpuIcon, LayersIcon, PlugIcon, ShieldIcon, SlidersIcon, WarnIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { Segmented } from './Segmented.tsx'
import { VerifySettings } from './VerifySettings.tsx'

export type SettingsSection = 'display' | 'board' | 'features' | 'integrations' | 'system'

export interface SettingsPanelProps {
  open: boolean
  onClose(): void
  setup?: SetupNoteState
  onOpenProfiles(): void
  onOpenWake(): void
  onOpenPhones(): void
  onOpenMokupilot(): void
  onOpenAccess(): void
  onOpenBackup(): void
  onOpenUpdates(): void
  onOpenHousekeeping(): void
  onOpenTimeSettings(): void
  onOpenCalendarSettings(): void
  onOpenLocalPaths(): void
  onOpenTeam(): void
  onOpenDevices(): void
}

const crossFade = (): ((apply: () => void) => unknown) | undefined =>
  typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !reducedMotion.matches
    ? apply => document.startViewTransition(apply)
    : undefined

function Switch({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onToggle(): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={classNames('set-switch', checked && 'on')}
      onClick={onToggle}
    />
  )
}

function LinkRow({
  label,
  meta,
  warn,
  danger,
  onClick,
}: {
  label: string
  meta?: ReactNode
  warn?: boolean
  danger?: boolean
  onClick(): void
}) {
  return (
    <button type="button" className={classNames('set-row set-link', danger && 'danger')} onClick={onClick}>
      <span className="set-lbl">
        <b>{label}</b>
      </span>
      <span className={classNames('set-link-meta', warn && 'warn')}>
        {warn && <WarnIcon />}
        {meta}
        {!danger && <ChevIcon />}
      </span>
    </button>
  )
}

export function SettingsPanel({
  open,
  onClose,
  setup,
  onOpenProfiles,
  onOpenWake,
  onOpenPhones,
  onOpenMokupilot,
  onOpenAccess,
  onOpenBackup,
  onOpenUpdates,
  onOpenHousekeeping,
  onOpenTimeSettings,
  onOpenCalendarSettings,
  onOpenLocalPaths,
  onOpenTeam,
  onOpenDevices,
}: SettingsPanelProps) {
  const t = useT()
  const { choose } = useLanguage()
  const { data, ui, canEdit, dispatch, toast, now } = useBoardContext()
  const place = usePanelPlace()
  const [section, setSection] = useState<SettingsSection>('display')
  // Preserve list scroll position when opening an inner Settings page and returning (#679).
  const paneRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const paneScroll = useRef(0)
  const navScroll = useRef({ top: 0, left: 0 })
  const rememberScroll = () => {
    if (paneRef.current) paneScroll.current = paneRef.current.scrollTop
    if (navRef.current) navScroll.current = { top: navRef.current.scrollTop, left: navRef.current.scrollLeft }
  }
  const openChild = (fn: () => void) => () => {
    rememberScroll()
    fn()
  }
  const selectSection = (next: SettingsSection) => {
    if (next === section) return
    paneScroll.current = 0
    if (paneRef.current) paneRef.current.scrollTop = 0
    setSection(next)
  }
  useLayoutEffect(() => {
    if (!open) return
    if (paneRef.current) paneRef.current.scrollTop = paneScroll.current
    if (navRef.current) {
      navRef.current.scrollTop = navScroll.current.top
      navRef.current.scrollLeft = navScroll.current.left
    }
  }, [open])
  // Local mirrors for document.documentElement dataset values so clicks re-render immediately.
  const [, setTick] = useState(0)
  const bump = () => setTick(n => n + 1)

  const rootEl = typeof document !== 'undefined' ? document.documentElement : { dataset: {} as DOMStringMap }
  const theme = themeNow(rootEl)
  const look = lookNow(rootEl)
  const cardText = cardTextNow(rootEl)
  const isRemote = remotePage()
  const canAdmin = adminHere()
  const languages = data?.languages ?? LANGUAGES
  // A node's master-owned features (#775): shown as the master has them, and written there through
  // the relay (#780); Tasks stay read-only here.
  const masterOwned = data?.masterFlags ?? null
  // On a node (#797): each row says whose it is, this computer's own or the master's.
  const onNode = !!masterOwned || !!data?.nodeMaster
  const headName = masterOwned?.master || data?.nodeMaster?.name || ''
  const headLabel = headName ? t('node.scope.head', { name: headName }) : t('node.scope.headNone')
  const hereMark = onNode ? <small className="set-owned">{t('node.scope.here')}</small> : null
  const ownedNote = masterOwned ? (
    <small className="set-owned" title={new Date(masterOwned.at).toLocaleString()}>
      {headLabel}
    </small>
  ) : null
  // As the master has them, not this computer's own (off) values.
  const owned = masterOwned ? masterOwnedNow(masterOwned) : null
  const presenceMode: PresenceMode | 'none' = owned ? owned.presence : (data?.presence?.mode ?? 'none')
  const idleMinutes = data?.presence?.idleMinutes ?? 15
  const todosMode: TodoMode = owned ? owned.todos : todoModeOf(data?.todos ?? null)
  const threadsInfo =
    data && canAdmin ? (owned ? { mode: owned.threads, share: owned.threadsShare } : threadsNow(data)) : null
  const features =
    data && canAdmin
      ? owned
        ? {
            watches: owned.watches,
            decisions: owned.decisions,
            ...(owned.decisions && { decisionsDefaults: owned.decisionsDefaults }),
            journal: owned.journal,
            ...(owned.threads !== 'none' && { threadsCases: owned.threadsCases }),
            ...(owned.threads !== 'none' &&
              owned.threadsVerify !== undefined && { threadsVerify: owned.threadsVerify }),
          }
        : featuresNow(data)
      : null
  const compact = data?.compactDefault
  const turnResumeOn = data?.turnResume !== false
  const compactChoices =
    compact && !COMPACT_CHOICES.includes(compact as (typeof COMPACT_CHOICES)[number])
      ? [...COMPACT_CHOICES, compact]
      : [...COMPACT_CHOICES]

  const backupProblem = data?.backup?.problem
  const wakeDown = canAdmin && isWakeView(data?.wake) && noteShown(data.wake, now)
  const systemWarn = !!setup?.shown || (!onNode && !!backupProblem) || wakeDown

  const pickTheme = (next: string) => {
    setTheme(next, { root: rootEl, keep: v => storage.set(THEME_KEY, v), transition: crossFade() })
    bump()
  }
  const pickLook = (next: string) => {
    setLook(next, { root: rootEl, keep: v => storage.set(LOOK_KEY, v), transition: crossFade() })
    if (next !== 'terminal') dispatch({ type: 'column', id: null })
    bump()
  }
  const pickCardText = (next: CardText) => {
    setCardText(next, { root: rootEl, keep: v => storage.set(CARD_TEXT_KEY, v), transition: crossFade() })
    bump()
  }
  const pickLang = (lang: string) => {
    void chooseLanguage(lang, { t, canEdit, choose, save: body => api.post('/api/settings', body), toast })
  }
  const pickFold = (mode: FoldMode) => {
    void chooseFold(mode, { t, canEdit, save: body => api.post('/api/settings', body), toast })
  }
  const pickCompact = (at: string) => {
    void chooseCompact(at, { t, canEdit, save: body => api.post('/api/settings', body), toast })
  }
  const pickTurnResume = (on: boolean) => {
    void chooseTurnResume(on, { t, canEdit, save: body => api.post('/api/settings', body), toast })
  }
  const pickPresence = (body: PresenceSetting) => {
    void choosePresence(body, { t, canEdit, save: b => api.post('/api/presence', b), toast })
  }
  const pickTodos = (mode: TodoMode) => {
    if (!canEdit) return toast(t('live.off'), true)
    api.post('/api/todos', { op: 'settings', mode }).catch(err => toast(errorText(err, t), true))
  }
  const pickThreads = (body: ThreadsSetting) => {
    if (!canEdit) return toast(t('live.off'), true)
    api
      .post('/api/threads-settings', body)
      .then(r => {
        const note = (r as { note?: unknown } | null)?.note
        if (typeof note === 'string' && note) toast(note, true)
      })
      .catch(err => toast(errorText(err, t), true))
  }
  const pickFeature = (body: FeatureSetting) => {
    if (!canEdit) return toast(t('live.off'), true)
    api.post('/api/feature-settings', body).catch(err => toast(errorText(err, t), true))
  }

  const sections: { id: SettingsSection; label: string; icon: ReactNode; warn?: boolean }[] = [
    { id: 'display', label: t('set.sec.display'), icon: <SlidersIcon /> },
    { id: 'board', label: t('set.sec.board'), icon: <CpuIcon /> },
    ...(canAdmin ? [{ id: 'features' as const, label: t('set.sec.features'), icon: <LayersIcon /> }] : []),
    { id: 'integrations', label: t('set.sec.integrations'), icon: <PlugIcon /> },
    { id: 'system', label: t('set.sec.system'), icon: <ShieldIcon />, warn: systemWarn },
  ]

  const todosRow = data ? (
    <div className="set-row">
      <div className="set-lbl">
        <b>{t('set.todos')}</b>
        <small>{t('set.todos.note')}</small>
      </div>
      <Segmented
        label={t('set.todos')}
        disabled={!canEdit || !!masterOwned}
        value={todosMode}
        options={TODO_MODES.map(id => ({ value: id, label: t(`set.todos.${id}`) }))}
        onChange={pickTodos}
      />
    </div>
  ) : null

  const shownProfiles = (data?.profiles ?? []).filter(p => !p.hidden).length
  const onlineDevices = (data?.devices ?? []).filter(reachable).length
  const team = teamBadge(data)

  return (
    <Panel
      id="settings-panel"
      kind="settings"
      open={open}
      onClose={onClose}
      measure="full"
      title={<h2>{t('set.title')}</h2>}
    >
      <div className="sheet-body set-shell">
        <nav className="set-nav" ref={navRef} aria-label={t('set.title')} onScroll={rememberScroll}>
          {sections.map(s => (
            <button
              key={s.id}
              type="button"
              className={classNames('set-tab', section === s.id && 'on')}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => selectSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
              {s.warn && <span className="set-tab-dot" aria-hidden="true" />}
            </button>
          ))}
          <div className="set-nav-foot">
            <span>
              {t('set.shortcut')}: <span className="kbd">,</span>
            </span>
          </div>
        </nav>

        <div className="set-pane" ref={paneRef} onScroll={rememberScroll}>
          {section === 'display' && (
            <section className="set-section">
              <div className="set-sec-head">
                <h3>{t('set.sec.display')}</h3>
                <span className="set-scope">{t('set.scope.browser')}</span>
              </div>
              <div className="set-group">
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('set.theme')}</b>
                    <small>{t('set.theme.note')}</small>
                  </div>
                  <Segmented
                    label={t('set.theme')}
                    value={theme}
                    options={THEMES.map(id => ({ value: id, label: t(`set.theme.${id}`) }))}
                    onChange={pickTheme}
                  />
                </div>
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('set.look')}</b>
                    <small>{t('set.look.note')}</small>
                  </div>
                  <Segmented
                    label={t('set.look')}
                    value={look}
                    options={LOOKS.map(id => ({ value: id, label: t(`set.look.${id}`) }))}
                    onChange={pickLook}
                  />
                </div>
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('set.cardText')}</b>
                    <small>{t('set.cardText.note')}</small>
                  </div>
                  <Segmented
                    label={t('set.cardText')}
                    value={cardText as CardText}
                    options={CARD_TEXTS.map(id => ({ value: id, label: t(`set.cardText.${id}`) }))}
                    onChange={pickCardText}
                  />
                </div>
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('set.panel')}</b>
                    <small>{t('set.panel.note')}</small>
                  </div>
                  <div className="set-inline">
                    <Segmented
                      label={t('set.panel')}
                      value={place.layout.dock}
                      options={DOCKS.map(id => ({ value: id, label: t(`panel.${id}`) }))}
                      onChange={dock => place.placePanels(dock as Dock)}
                    />
                    <button type="button" className="set-reset" onClick={() => place.resetPanelSize()}>
                      {t('panel.reset')}
                    </button>
                  </div>
                </div>
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('tb.sleepersTitle')}</b>
                    <small>{t('set.sleepers.note')}</small>
                  </div>
                  <Switch
                    checked={ui.sleepers}
                    label={t('tb.sleepersTitle')}
                    onToggle={() => dispatch({ type: 'toggleSleepers' })}
                  />
                </div>
                {data?.foldWaiting && (
                  <div className="set-row">
                    <div className="set-lbl">
                      <b>{t('set.fold')}</b>
                      <small>{t('set.fold.note')}</small>
                    </div>
                    <select
                      className="set-select"
                      aria-label={t('set.fold')}
                      disabled={!canEdit}
                      value={data.foldWaiting}
                      onChange={e => pickFold(e.currentTarget.value as FoldMode)}
                    >
                      {FOLD_MODES.map(id => (
                        <option key={id} value={id}>
                          {t(`set.fold.${id}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </section>
          )}

          {section === 'board' && (
            <section className="set-section">
              <div className="set-sec-head">
                <h3>{t('set.sec.board')}</h3>
                <span className="set-scope">{t('set.scope.board')}</span>
              </div>
              <div className="set-group">
                <div className="set-row">
                  <div className="set-lbl">
                    <b>{t('set.lang')}</b>
                    <small>{t('set.lang.note')}</small>
                    {hereMark}
                  </div>
                  <select
                    className="set-select"
                    aria-label={t('set.lang')}
                    disabled={!canEdit}
                    value={t.lang}
                    onChange={e => pickLang(e.currentTarget.value)}
                  >
                    {Object.entries(languages).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                {data && (
                  <div className="set-row">
                    <div className="set-lbl">
                      <b>{t('set.presence')}</b>
                      <small>{masterOwned ? headLabel : t('set.presence.note')}</small>
                    </div>
                    <select
                      className="set-select"
                      aria-label={t('set.presence')}
                      disabled={!canEdit}
                      value={presenceMode}
                      onChange={e => {
                        const v = e.currentTarget.value as PresenceMode | 'none'
                        pickPresence(v === 'none' ? { on: false } : { on: true, mode: v })
                      }}
                    >
                      {(['none', ...PRESENCE_MODES] as const).map(id => (
                        <option key={id} value={id}>
                          {t(`set.presence.${id}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {data && presenceMode !== 'none' && presenceMode !== 'off' && (
                  <div className="set-row">
                    <div className="set-lbl">
                      <b>{t('set.presence.idleLabel')}</b>
                    </div>
                    <select
                      className="set-select"
                      aria-label={t('set.presence.idleLabel')}
                      disabled={!canEdit}
                      value={idleMinutes}
                      onChange={e => pickPresence({ on: true, idleMinutes: Number(e.currentTarget.value) })}
                    >
                      {PRESENCE_IDLE_CHOICES.map(min => (
                        <option key={min} value={min}>
                          {t('set.presence.idle', { min })}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {compact !== undefined && (
                  <div className="set-row">
                    <div className="set-lbl">
                      <b>{t('set.compact')}</b>
                      <small>{t('set.compact.note')}</small>
                      {hereMark}
                    </div>
                    <select
                      className="set-select"
                      aria-label={t('set.compact')}
                      disabled={!canEdit}
                      value={compact || 'off'}
                      onChange={e => pickCompact(e.currentTarget.value === 'off' ? '' : e.currentTarget.value)}
                    >
                      <option value="off">{t('set.compact.off')}</option>
                      {compactChoices.map(at => (
                        <option key={at} value={at}>
                          {at.endsWith('%')
                            ? t('set.compact.share', { share: at })
                            : t('set.compact.tokens', { tokens: at })}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {data && (
                  <div className="set-row">
                    <div className="set-lbl">
                      <b>{t('set.turnResume')}</b>
                      <small>{t('set.turnResume.note')}</small>
                      {hereMark}
                    </div>
                    <Switch
                      checked={turnResumeOn}
                      disabled={!canEdit}
                      label={t('set.turnResume')}
                      onToggle={() => pickTurnResume(!turnResumeOn)}
                    />
                  </div>
                )}
                {/* Where Features is not shown (#797): with it, Tasks are there only. */}
                {isRemote && !canAdmin && todosRow}
              </div>
            </section>
          )}

          {section === 'features' && canAdmin && (
            <section className="set-section">
              <div className="set-sec-head">
                <h3>{t('set.sec.features')}</h3>
                <span className="set-scope">{t('set.scope.board')}</span>
              </div>
              {ownedNote}
              <div className="set-group">
                {todosRow}
                {threadsInfo && (
                  <>
                    <div className="set-row">
                      <div className="set-lbl">
                        <b>{t('set.threads')}</b>
                        <small>{t('set.threads.note')}</small>
                      </div>
                      <Segmented
                        label={t('set.threads')}
                        disabled={!canEdit}
                        value={threadsInfo.mode}
                        options={THREAD_MODES.map(id => ({ value: id, label: t(`set.threads.${id}`) }))}
                        onChange={mode => pickThreads({ mode })}
                      />
                    </div>
                    {threadsInfo.mode !== 'none' && (
                      <>
                        {(threadsInfo.share !== undefined || features?.threadsCases !== undefined) && (
                          <div className="set-sub">
                            {threadsInfo.share !== undefined && (
                              <label className="set-chk">
                                <input
                                  type="checkbox"
                                  disabled={!canEdit}
                                  checked={threadsInfo.share}
                                  onChange={e => pickThreads({ share: e.currentTarget.checked })}
                                />
                                <span>{t('set.threads.shareLabel')}</span>
                              </label>
                            )}
                            {features?.threadsCases !== undefined && (
                              <label className="set-chk" title={t('set.cases.note')}>
                                <input
                                  type="checkbox"
                                  disabled={!canEdit}
                                  checked={features.threadsCases}
                                  onChange={e => pickThreads({ cases: e.currentTarget.checked })}
                                />
                                <span>{t('set.cases')}</span>
                              </label>
                            )}
                          </div>
                        )}
                        {features?.threadsVerify !== undefined && (
                          <VerifySettings
                            verifyOn={features.threadsVerify}
                            canEdit={canEdit}
                            onToggle={next => pickThreads({ verify: next })}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
                {features && (
                  <>
                    <div className="set-row">
                      <div className="set-lbl">
                        <b>{t('set.decisions')}</b>
                        <small>
                          {features.decisions && features.defaultsRunning
                            ? t('set.decisions.offNote', { n: features.defaultsRunning })
                            : t('set.decisions.note')}
                        </small>
                      </div>
                      <div className="set-inline">
                        {features.decisions && features.decisionsDefaults !== undefined && (
                          <label className="set-chk">
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={features.decisionsDefaults}
                              onChange={e => pickFeature({ decisionsDefaults: e.currentTarget.checked })}
                            />
                            <span>{t('set.decisions.defaults')}</span>
                          </label>
                        )}
                        <Switch
                          checked={!!features.decisions}
                          disabled={!canEdit}
                          label={t('set.decisions')}
                          onToggle={() => pickFeature({ decisions: !features.decisions })}
                        />
                      </div>
                    </div>
                    <div className="set-row">
                      <div className="set-lbl">
                        <b>{t('set.watches')}</b>
                        <small>
                          {features.watches && features.watchesRunning
                            ? t('set.watches.offNote', { n: features.watchesRunning })
                            : t('set.watches.note')}
                        </small>
                      </div>
                      <Switch
                        checked={!!features.watches}
                        disabled={!canEdit}
                        label={t('set.watches')}
                        onToggle={() => pickFeature({ watches: !features.watches })}
                      />
                    </div>
                    <div className="set-row">
                      <div className="set-lbl">
                        <b>{t('set.journal')}</b>
                        <small className={classNames(features.journalError && 'set-err')}>
                          {features.journal && features.journalError
                            ? t('set.journal.error', { error: features.journalError })
                            : t('set.journal.note')}
                        </small>
                      </div>
                      <Switch
                        checked={!!features.journal}
                        disabled={!canEdit}
                        label={t('set.journal')}
                        onToggle={() => pickFeature({ journal: !features.journal })}
                      />
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {section === 'integrations' && (
            <section className="set-section">
              <div className="set-sec-head">
                <h3>{t('set.sec.integrations')}</h3>
                <span className="set-scope">{t('set.scope.panels')}</span>
              </div>
              <div className="set-group">
                {offersProfiles(data?.profiles) && (
                  <LinkRow
                    label={t('set.profiles')}
                    meta={<span>{t('set.integrations.shown', { n: shownProfiles })}</span>}
                    onClick={openChild(onOpenProfiles)}
                  />
                )}
                {isWakeView(data?.wake) && (
                  <LinkRow
                    label={t('set.wake')}
                    meta={<span>{wakeDown ? t('wake.stopped') : t('set.integrations.on')}</span>}
                    warn={wakeDown}
                    onClick={openChild(onOpenWake)}
                  />
                )}
                {canAdmin && (
                  <LinkRow
                    label={t('set.calendar')}
                    meta={
                      <span>
                        {data?.calendar
                          ? data.calendar.failing > 0
                            ? t('set.integrations.problem')
                            : t('set.integrations.on')
                          : t('set.integrations.off')}
                      </span>
                    }
                    warn={(data?.calendar?.failing ?? 0) > 0}
                    onClick={openChild(onOpenCalendarSettings)}
                  />
                )}
                {canAdmin && (
                  <LinkRow
                    label={t('set.time')}
                    meta={<span>{data?.time ? t('set.integrations.on') : t('set.integrations.off')}</span>}
                    onClick={openChild(onOpenTimeSettings)}
                  />
                )}
                {offersTeam(data) && (
                  <LinkRow
                    label={t('set.team')}
                    meta={
                      <span>{team.count > 0 ? t('team.unread', { n: team.count }) : t('set.integrations.on')}</span>
                    }
                    onClick={openChild(onOpenTeam)}
                  />
                )}
                {offersMokupilot(data) && <LinkRow label={t('set.mokupilot')} onClick={openChild(onOpenMokupilot)} />}
                {offersDevices(isRemote, ownerAdminPage()) && (
                  <LinkRow
                    label={t('node.set.devices')}
                    meta={
                      data?.devices?.length ? (
                        <span>{t('set.integrations.online', { n: onlineDevices })}</span>
                      ) : undefined
                    }
                    onClick={openChild(onOpenDevices)}
                  />
                )}
                {!!data?.remote && <LinkRow label={t('set.phones')} onClick={openChild(onOpenPhones)} />}
                {canAdmin && <LinkRow label={t('set.access')} onClick={openChild(onOpenAccess)} />}
                {isRemote && <LinkRow label={t('set.localPaths')} onClick={openChild(onOpenLocalPaths)} />}
              </div>
            </section>
          )}

          {section === 'system' && (
            <section className="set-section">
              <div className="set-sec-head">
                <h3>{t('set.sec.system')}</h3>
                <span className="set-scope">{t('set.scope.panels')}</span>
              </div>
              <div className="set-group">
                {canAdmin && (
                  <LinkRow
                    label={t('set.backup')}
                    meta={
                      <span>
                        {onNode
                          ? headLabel
                          : backupProblem
                            ? backupNoteText(backupProblem, t)
                            : t('set.integrations.on')}
                      </span>
                    }
                    warn={!onNode && !!backupProblem}
                    onClick={openChild(onOpenBackup)}
                  />
                )}
                {canAdmin && <LinkRow label={t('set.updates')} onClick={openChild(onOpenUpdates)} />}
                {canAdmin && (
                  <LinkRow
                    label={t('set.housekeeping')}
                    meta={
                      <span>
                        {t('set.housekeeping.meta', {
                          memory: t(data?.housekeeping?.memory ? 'set.state.on' : 'set.state.off'),
                          tabs: t(data?.housekeeping?.tabs ? 'set.state.on' : 'set.state.off'),
                        })}
                      </span>
                    }
                    onClick={openChild(onOpenHousekeeping)}
                  />
                )}
                {setup && (
                  <LinkRow
                    label={t('set.setup')}
                    meta={<span>{t(setup.shown ? 'set.setup.warn' : 'set.setup.ok')}</span>}
                    warn={setup.shown}
                    onClick={() => setup.toggle()}
                  />
                )}
                {isRemote && keptAuth() === 'login' && (
                  <LinkRow label={t('set.signOut')} danger onClick={() => void endLogin({ t, toast })} />
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </Panel>
  )
}
