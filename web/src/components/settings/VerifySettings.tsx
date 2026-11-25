// Verified done settings section (#680): opens from the Verified done row inside Settings ->
// Features, reading and writing `threads.verify` fields via GET/POST /api/threads-settings.
import { useCallback, useEffect, useState } from 'react'
import { CLAUDE_MODEL_ALIASES } from '../../../../src/core/launch/model.ts'
import { LOCAL } from '../../../../src/core/node-key.ts'
import {
  VERIFY_CODE_CHECKLIST,
  VERIFY_LIMIT_MIN_MAX,
  VERIFY_MAX_LIMIT,
  type VerifySettingsData,
  type VerifySettingsPatch,
  type VerifySettingsView,
} from '../../../../src/core/work-threads.ts'
import { api, errorText, isReply, replyOf } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { deviceTitle } from '../../models/devices.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { ChevIcon, CrossIcon } from '../icons.tsx'

/** Claude aliases suggested for the verifier model (sonnet, opus, haiku first). */
export const VERIFY_MODEL_CHOICES: readonly string[] = [
  'sonnet',
  'opus',
  'haiku',
  ...CLAUDE_MODEL_ALIASES.filter(a => a !== 'sonnet' && a !== 'opus' && a !== 'haiku'),
]

const CUSTOM_OPT = '__custom__'

/** Runtime check for the JSON answered by `GET /api/threads-settings`. */
export function isVerifySettingsView(v: unknown): v is VerifySettingsView {
  if (!isReply(v) || typeof v.threadsOn !== 'boolean' || !isReply(v.verify)) return false
  const verify = v.verify
  if (typeof verify.on !== 'boolean' || !isReply(verify.settings) || !isReply(verify.defaults)) return false
  const s = verify.settings
  if (!Array.isArray(s.lanes)) return false
  return typeof verify.defaults.limitMin === 'number' && typeof verify.defaults.max === 'number'
}

const hasConfiguredValues = (s: VerifySettingsData): boolean =>
  s.model !== null ||
  s.profile !== null ||
  s.lanes.length > 0 ||
  s.brief !== null ||
  s.limitMin !== null ||
  s.max !== null

export interface VerifySettingsProps {
  verifyOn: boolean
  canEdit: boolean
  onToggle(next: boolean): void
}

export function VerifySettings({ verifyOn, canEdit, onToggle }: VerifySettingsProps) {
  const t = useT()
  const { data, toast } = useBoardContext()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<VerifySettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [modelMode, setModelMode] = useState<'default' | 'alias' | 'custom'>('default')
  const [customModel, setCustomModel] = useState('')
  const [defaultBriefMode, setDefaultBriefMode] = useState<'default' | 'code' | 'custom'>('default')
  const [customDefaultBrief, setCustomDefaultBrief] = useState('')
  const [laneCustomModes, setLaneCustomModes] = useState<Record<string, boolean>>({})
  const [laneBriefDrafts, setLaneBriefDrafts] = useState<Record<string, string>>({})
  const [nodeProfileDrafts, setNodeProfileDrafts] = useState<Record<string, string>>({})
  const [limitMinDraft, setLimitMinDraft] = useState('')
  const [maxDraft, setMaxDraft] = useState('')

  const syncDrafts = useCallback((s: VerifySettingsData) => {
    if (s.model === null) {
      setModelMode('default')
      setCustomModel('')
    } else if (VERIFY_MODEL_CHOICES.includes(s.model)) {
      setModelMode('alias')
      setCustomModel('')
    } else {
      setModelMode('custom')
      setCustomModel(s.model)
    }

    const defaultBrief = typeof s.brief === 'string' ? s.brief : (s.brief?.['*'] ?? '')
    if (!defaultBrief) {
      setDefaultBriefMode('default')
      setCustomDefaultBrief('')
    } else if (defaultBrief === VERIFY_CODE_CHECKLIST) {
      setDefaultBriefMode('code')
      setCustomDefaultBrief('')
    } else {
      setDefaultBriefMode('custom')
      setCustomDefaultBrief(defaultBrief)
    }

    const nextLaneDrafts: Record<string, string> = {}
    const nextLaneCustom: Record<string, boolean> = {}
    if (s.brief && typeof s.brief === 'object') {
      for (const [lane, path] of Object.entries(s.brief)) {
        if (lane === '*') continue
        nextLaneCustom[lane] = path !== VERIFY_CODE_CHECKLIST
        nextLaneDrafts[lane] = path
      }
    }
    setLaneCustomModes(nextLaneCustom)
    setLaneBriefDrafts(nextLaneDrafts)

    const nextNodeDrafts: Record<string, string> = {}
    if (s.profile && typeof s.profile === 'object') {
      for (const [dev, prof] of Object.entries(s.profile)) nextNodeDrafts[dev] = prof
    }
    setNodeProfileDrafts(nextNodeDrafts)

    setLimitMinDraft(s.limitMin !== null ? String(s.limitMin) : '')
    setMaxDraft(s.max !== null ? String(s.max) : '')
  }, [])

  // Trigger a refresh whenever the panel opens or the parent switch changes while open.
  const refreshTrigger = open ? verifyOn : null
  useEffect(() => {
    if (refreshTrigger === null) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/threads-settings', { cache: 'no-store' })
        const body = await replyOf(res)
        if (cancelled) return
        if (res.ok && isVerifySettingsView(body)) {
          setView(body)
          syncDrafts(body.verify.settings)
          setLoadError(null)
          setSaveError(null)
        } else {
          setLoadError(t('err.status', { code: res.status }))
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorText(err, t))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshTrigger, syncDrafts, t])

  const savePatch = async (patch: VerifySettingsPatch) => {
    if (!canEdit) return toast(t('live.off'), true)
    setBusy(true)
    setSaveError(null)
    try {
      await api.post('/api/threads-settings', { verifySettings: patch })
      const res = await fetch('/api/threads-settings', { cache: 'no-store' })
      const body = await replyOf(res)
      if (res.ok && isVerifySettingsView(body)) {
        setView(body)
        syncDrafts(body.verify.settings)
      }
    } catch (err) {
      const msg = errorText(err, t)
      setSaveError(msg)
      toast(msg, true)
    } finally {
      setBusy(false)
    }
  }

  const settings = view?.verify.settings
  const defaults = view?.verify.defaults
  const disabled = !canEdit || busy

  const shownProfiles = (data?.profiles ?? []).filter(p => !p.hidden)
  const activeDevices = (data?.devices ?? []).filter(d => !d.revoked)
  const remoteDevices = activeDevices.filter(d => d.id !== LOCAL)
  const perDeviceProfile =
    remoteDevices.length > 0 ||
    (settings?.profile !== null && settings?.profile !== undefined && typeof settings.profile === 'object')

  const laneEntries = data?.categories ?? []
  const laneTitle = (id: string) => laneEntries.find(c => c.id === id)?.title ?? id
  const allLanes = (() => {
    const known = new Set(laneEntries.map(c => c.id))
    const extra = (settings?.lanes ?? []).filter(id => !known.has(id)).map(id => ({ id, title: id, color: '' }))
    return [...laneEntries.map(c => ({ id: c.id, title: c.title, color: c.color })), ...extra]
  })()

  const defaultBriefPath = !settings?.brief
    ? ''
    : typeof settings.brief === 'string'
      ? settings.brief
      : (settings.brief['*'] ?? '')
  const laneBriefEntries: [string, string][] =
    settings?.brief && typeof settings.brief === 'object'
      ? Object.entries(settings.brief).filter(([lane]) => lane !== '*')
      : []

  const saveBrief = (nextDefault: string, nextLanes: [string, string][]) => {
    const cleanDefault = nextDefault.trim()
    const validLanes = nextLanes.filter(([, p]) => p.trim() !== '').map(([l, p]) => [l, p.trim()] as const)
    if (validLanes.length === 0) {
      void savePatch({ brief: cleanDefault || null })
    } else {
      const obj: Record<string, string> = {}
      if (cleanDefault) obj['*'] = cleanDefault
      for (const [l, p] of validLanes) obj[l] = p
      void savePatch({ brief: obj })
    }
  }

  const updateDeviceProfile = (deviceId: string, nextVal: string) => {
    if (!settings) return
    const current = settings.profile
    const wasExplicitMap = current !== null && typeof current === 'object'
    const map: Record<string, string> =
      typeof current === 'string' ? { [LOCAL]: current } : current ? { ...current } : {}
    const clean = nextVal.trim()
    if (clean) map[deviceId] = clean
    else delete map[deviceId]
    const keys = Object.keys(map)
    if (keys.length === 0) {
      void savePatch({ profile: null })
    } else if (keys.length === 1 && keys[0] === LOCAL && !wasExplicitMap) {
      void savePatch({ profile: map[LOCAL] ?? null })
    } else {
      void savePatch({ profile: map })
    }
  }

  const commitLimitMin = () => {
    if (!settings) return
    const trimmed = limitMinDraft.trim()
    if (!trimmed) {
      setSaveError(null)
      if (settings.limitMin !== null) void savePatch({ limitMin: null })
      return
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n < 1 || n > VERIFY_LIMIT_MIN_MAX) {
      setSaveError(t('verify.err.limitMin'))
      return
    }
    setSaveError(null)
    if (n !== settings.limitMin) void savePatch({ limitMin: n })
  }

  const commitMax = () => {
    if (!settings) return
    const trimmed = maxDraft.trim()
    if (!trimmed) {
      setSaveError(null)
      if (settings.max !== null) void savePatch({ max: null })
      return
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n < 1 || n > VERIFY_MAX_LIMIT) {
      setSaveError(t('verify.err.max'))
      return
    }
    setSaveError(null)
    if (n !== settings.max) void savePatch({ max: n })
  }

  const deviceProfileValue = (deviceId: string): string => {
    if (!settings?.profile) return ''
    if (typeof settings.profile === 'string') return deviceId === LOCAL ? settings.profile : ''
    return settings.profile[deviceId] ?? ''
  }

  const extraProfileDevices =
    settings?.profile && typeof settings.profile === 'object'
      ? Object.keys(settings.profile).filter(id => id !== LOCAL && !remoteDevices.some(d => d.id === id))
      : []

  const unconfiguredBriefLanes = laneEntries.filter(c => !laneBriefEntries.some(([id]) => id === c.id))

  return (
    <>
      <div className="set-row set-verify-row">
        <div className="set-lbl">
          <b>{t('set.verify')}</b>
          <small>{t('set.verify.note')}</small>
        </div>
        <div className="set-inline">
          <button
            type="button"
            className={classNames('set-reset set-verify-btn', open && 'open')}
            aria-expanded={open}
            aria-controls="set-verify-section"
            onClick={() => setOpen(v => !v)}
          >
            <span>{open ? t('set.verify.hide') : t('set.verify.configure')}</span>
            <ChevIcon />
          </button>
          <Switch checked={verifyOn} disabled={!canEdit} label={t('set.verify')} onToggle={() => onToggle(!verifyOn)} />
        </div>
      </div>

      {open && (
        <div id="set-verify-section" className="set-verify-sec">
          {!verifyOn && settings && hasConfiguredValues(settings) && (
            <p className="set-verify-kept">{t('set.verify.offKept')}</p>
          )}
          {loadError ? (
            <p className="set-err" role="alert">
              {t('set.verify.loadError', { error: loadError })}
            </p>
          ) : !settings || !defaults ? (
            <p className="set-verify-note">{t('set.verify.loading')}</p>
          ) : (
            <>
              {saveError && (
                <p className="set-err" role="alert">
                  {saveError}
                </p>
              )}

              {/* Model */}
              <div className="set-verify-field">
                <div className="set-verify-field-head">
                  <div className="set-lbl">
                    <b>{t('set.verify.model')}</b>
                    <small>{t('set.verify.model.note')}</small>
                  </div>
                  <select
                    className="set-select"
                    aria-label={t('set.verify.model')}
                    disabled={disabled}
                    value={
                      modelMode === 'custom'
                        ? CUSTOM_OPT
                        : modelMode === 'alias' && settings.model
                          ? settings.model
                          : ''
                    }
                    onChange={e => {
                      const val = e.currentTarget.value
                      if (val === '') {
                        setModelMode('default')
                        setCustomModel('')
                        if (settings.model !== null) void savePatch({ model: null })
                      } else if (val === CUSTOM_OPT) {
                        setModelMode('custom')
                        setCustomModel(settings.model ?? '')
                      } else {
                        setModelMode('alias')
                        setCustomModel('')
                        if (val !== settings.model) void savePatch({ model: val })
                      }
                    }}
                  >
                    <option value="">{t('set.verify.model.default')}</option>
                    {VERIFY_MODEL_CHOICES.map(alias => (
                      <option key={alias} value={alias}>
                        {alias}
                      </option>
                    ))}
                    <option value={CUSTOM_OPT}>{t('set.verify.model.custom')}</option>
                  </select>
                </div>
                {modelMode === 'custom' && (
                  <div className="set-verify-custom">
                    <input
                      type="text"
                      className="set-input"
                      aria-label={`${t('set.verify.model')} (${t('set.verify.model.custom')})`}
                      disabled={disabled}
                      placeholder={t('set.verify.model.placeholder')}
                      value={customModel}
                      onChange={e => setCustomModel(e.currentTarget.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const trimmed = customModel.trim()
                          void savePatch({ model: trimmed || null })
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="set-reset"
                      disabled={disabled}
                      onClick={() => void savePatch({ model: customModel.trim() || null })}
                    >
                      {t('set.verify.apply')}
                    </button>
                    {settings.model !== null && (
                      <button
                        type="button"
                        className="set-clear"
                        disabled={disabled}
                        onClick={() => void savePatch({ model: null })}
                      >
                        {t('set.verify.clear')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Profile */}
              <div className="set-verify-field">
                <div className="set-verify-field-head">
                  <div className="set-lbl">
                    <b>{t('set.verify.profile')}</b>
                    <small>{t('set.verify.profile.note')}</small>
                  </div>
                  {!perDeviceProfile && (
                    <select
                      className="set-select"
                      aria-label={t('set.verify.profile')}
                      disabled={disabled}
                      value={typeof settings.profile === 'string' ? settings.profile : ''}
                      onChange={e => void savePatch({ profile: e.currentTarget.value || null })}
                    >
                      <option value="">{t('set.verify.profile.auto')}</option>
                      {shownProfiles.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.title !== p.id ? `${p.title} (${p.id})` : p.id}
                        </option>
                      ))}
                      {typeof settings.profile === 'string' &&
                        settings.profile &&
                        !shownProfiles.some(p => p.id === settings.profile) && (
                          <option value={settings.profile}>{settings.profile}</option>
                        )}
                    </select>
                  )}
                </div>
                {perDeviceProfile && (
                  <div className="set-verify-list">
                    <div className="set-verify-list-row">
                      <span className="set-verify-dev">
                        {(() => {
                          const localDev = activeDevices.find(d => d.id === LOCAL)
                          return localDev ? deviceTitle(localDev, t) : t('set.verify.device.local')
                        })()}
                      </span>
                      <select
                        className="set-select"
                        aria-label={`${t('set.verify.profile')} (${LOCAL})`}
                        disabled={disabled}
                        value={deviceProfileValue(LOCAL)}
                        onChange={e => updateDeviceProfile(LOCAL, e.currentTarget.value)}
                      >
                        <option value="">{t('set.verify.profile.auto')}</option>
                        {shownProfiles.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.title !== p.id ? `${p.title} (${p.id})` : p.id}
                          </option>
                        ))}
                        {deviceProfileValue(LOCAL) && !shownProfiles.some(p => p.id === deviceProfileValue(LOCAL)) && (
                          <option value={deviceProfileValue(LOCAL)}>{deviceProfileValue(LOCAL)}</option>
                        )}
                      </select>
                    </div>
                    {remoteDevices.map(dev => {
                      const val = deviceProfileValue(dev.id)
                      const nodeProfiles = dev.status?.profiles ?? []
                      return (
                        <div key={dev.id} className="set-verify-list-row">
                          <span className="set-verify-dev">{dev.title || dev.id}</span>
                          {nodeProfiles.length > 0 ? (
                            <select
                              className="set-select"
                              aria-label={`${t('set.verify.profile')} (${dev.id})`}
                              disabled={disabled}
                              value={val}
                              onChange={e => updateDeviceProfile(dev.id, e.currentTarget.value)}
                            >
                              <option value="">{t('set.verify.profile.nodeAuto')}</option>
                              {nodeProfiles.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.id}
                                </option>
                              ))}
                              {val && !nodeProfiles.some(p => p.id === val) && <option value={val}>{val}</option>}
                            </select>
                          ) : (
                            <div className="set-inline">
                              <input
                                type="text"
                                className="set-input"
                                aria-label={`${t('set.verify.profile')} (${dev.id})`}
                                disabled={disabled}
                                placeholder={t('set.verify.profile.nodeAuto')}
                                value={nodeProfileDrafts[dev.id] ?? val}
                                onChange={e => {
                                  const next = e.currentTarget.value
                                  setNodeProfileDrafts(prev => ({ ...prev, [dev.id]: next }))
                                }}
                                onBlur={() => {
                                  const draft = (nodeProfileDrafts[dev.id] ?? val).trim()
                                  if (draft !== val) updateDeviceProfile(dev.id, draft)
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    const draft = (nodeProfileDrafts[dev.id] ?? val).trim()
                                    updateDeviceProfile(dev.id, draft)
                                  }
                                }}
                              />
                              {val && (
                                <button
                                  type="button"
                                  className="set-clear"
                                  disabled={disabled}
                                  onMouseDown={e => e.preventDefault()}
                                  onClick={() => updateDeviceProfile(dev.id, '')}
                                >
                                  {t('set.verify.clear')}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {extraProfileDevices.map(devId => {
                      const val = deviceProfileValue(devId)
                      return (
                        <div key={devId} className="set-verify-list-row">
                          <span className="set-verify-dev">{devId}</span>
                          <div className="set-inline">
                            <input
                              type="text"
                              className="set-input"
                              aria-label={`${t('set.verify.profile')} (${devId})`}
                              disabled={disabled}
                              placeholder={t('set.verify.profile.nodeAuto')}
                              value={nodeProfileDrafts[devId] ?? val}
                              onChange={e => {
                                const next = e.currentTarget.value
                                setNodeProfileDrafts(prev => ({ ...prev, [devId]: next }))
                              }}
                              onBlur={() => {
                                const draft = (nodeProfileDrafts[devId] ?? val).trim()
                                if (draft !== val) updateDeviceProfile(devId, draft)
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  const draft = (nodeProfileDrafts[devId] ?? val).trim()
                                  updateDeviceProfile(devId, draft)
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="set-clear"
                              disabled={disabled}
                              onMouseDown={e => e.preventDefault()}
                              onClick={() => updateDeviceProfile(devId, '')}
                            >
                              {t('set.verify.clear')}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Lanes */}
              <div className="set-verify-field">
                <div className="set-verify-field-head">
                  <div className="set-lbl">
                    <b>{t('set.verify.lanes')}</b>
                    <small>{t('set.verify.lanes.note')}</small>
                  </div>
                  {settings.lanes.length > 0 && (
                    <button
                      type="button"
                      className="set-clear"
                      disabled={disabled}
                      onClick={() => void savePatch({ lanes: [] })}
                    >
                      {t('set.verify.clear')}
                    </button>
                  )}
                </div>
                {allLanes.length > 0 && (
                  <div className="set-verify-lanes">
                    {allLanes.map(cat => {
                      const checked = settings.lanes.includes(cat.id)
                      return (
                        <label key={cat.id} className="set-chk set-verify-lane">
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={checked}
                            onChange={e => {
                              const next = e.currentTarget.checked
                                ? [...settings.lanes, cat.id]
                                : settings.lanes.filter(l => l !== cat.id)
                              void savePatch({ lanes: next })
                            }}
                          />
                          {cat.color && (
                            <span className="set-verify-dot" style={{ background: cat.color }} aria-hidden="true" />
                          )}
                          <span>{cat.title}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Checklist */}
              <div className="set-verify-field">
                <div className="set-verify-field-head">
                  <div className="set-lbl">
                    <b>{t('set.verify.brief')}</b>
                    <small>{t('set.verify.brief.note')}</small>
                  </div>
                  <select
                    className="set-select"
                    aria-label={t('set.verify.brief')}
                    disabled={disabled}
                    value={
                      defaultBriefMode === 'custom'
                        ? CUSTOM_OPT
                        : defaultBriefMode === 'code'
                          ? VERIFY_CODE_CHECKLIST
                          : ''
                    }
                    onChange={e => {
                      const val = e.currentTarget.value
                      if (val === '') {
                        setDefaultBriefMode('default')
                        setCustomDefaultBrief('')
                        if (defaultBriefPath !== '') saveBrief('', laneBriefEntries)
                      } else if (val === VERIFY_CODE_CHECKLIST) {
                        setDefaultBriefMode('code')
                        setCustomDefaultBrief('')
                        if (defaultBriefPath !== VERIFY_CODE_CHECKLIST)
                          saveBrief(VERIFY_CODE_CHECKLIST, laneBriefEntries)
                      } else {
                        setDefaultBriefMode('custom')
                        setCustomDefaultBrief(defaultBriefPath)
                      }
                    }}
                  >
                    <option value="">{t('set.verify.brief.default')}</option>
                    <option value={VERIFY_CODE_CHECKLIST}>{t('set.verify.brief.code')}</option>
                    <option value={CUSTOM_OPT}>{t('set.verify.brief.custom')}</option>
                  </select>
                </div>
                {defaultBriefMode === 'custom' && (
                  <div className="set-verify-custom">
                    <input
                      type="text"
                      className="set-input"
                      aria-label={`${t('set.verify.brief')} (${t('set.verify.brief.custom')})`}
                      disabled={disabled}
                      placeholder={t('set.verify.brief.placeholder')}
                      value={customDefaultBrief}
                      onChange={e => setCustomDefaultBrief(e.currentTarget.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveBrief(customDefaultBrief, laneBriefEntries)
                      }}
                    />
                    <button
                      type="button"
                      className="set-reset"
                      disabled={disabled}
                      onClick={() => saveBrief(customDefaultBrief, laneBriefEntries)}
                    >
                      {t('set.verify.apply')}
                    </button>
                    {defaultBriefPath && (
                      <button
                        type="button"
                        className="set-clear"
                        disabled={disabled}
                        onClick={() => saveBrief('', laneBriefEntries)}
                      >
                        {t('set.verify.clear')}
                      </button>
                    )}
                  </div>
                )}

                {(laneBriefEntries.length > 0 || unconfiguredBriefLanes.length > 0) && (
                  <div className="set-verify-list">
                    {laneBriefEntries.map(([lane, path]) => {
                      const isCustom = laneCustomModes[lane] ?? path !== VERIFY_CODE_CHECKLIST
                      const draft = laneBriefDrafts[lane] ?? path
                      const replaceLane = (nextPath: string) =>
                        saveBrief(
                          defaultBriefPath,
                          laneBriefEntries.map(([l, p]) => (l === lane ? [l, nextPath] : [l, p])),
                        )
                      return (
                        <div key={lane} className="set-verify-list-row set-verify-brief-lane">
                          <span className="set-verify-dev">{laneTitle(lane)}</span>
                          <div className="set-inline">
                            <select
                              className="set-select"
                              aria-label={`${t('set.verify.brief')} (${lane})`}
                              disabled={disabled}
                              value={isCustom ? CUSTOM_OPT : VERIFY_CODE_CHECKLIST}
                              onChange={e => {
                                const val = e.currentTarget.value
                                if (val === VERIFY_CODE_CHECKLIST) {
                                  setLaneCustomModes(prev => ({ ...prev, [lane]: false }))
                                  if (path !== VERIFY_CODE_CHECKLIST) replaceLane(VERIFY_CODE_CHECKLIST)
                                } else {
                                  setLaneCustomModes(prev => ({ ...prev, [lane]: true }))
                                  setLaneBriefDrafts(prev => ({ ...prev, [lane]: path }))
                                }
                              }}
                            >
                              <option value={VERIFY_CODE_CHECKLIST}>{t('set.verify.brief.code')}</option>
                              <option value={CUSTOM_OPT}>{t('set.verify.brief.custom')}</option>
                            </select>
                            {isCustom && (
                              <>
                                <input
                                  type="text"
                                  className="set-input"
                                  aria-label={`${t('set.verify.brief')} (${lane}, ${t('set.verify.brief.custom')})`}
                                  disabled={disabled}
                                  placeholder={t('set.verify.brief.placeholder')}
                                  value={draft}
                                  onChange={e => {
                                    const val = e.currentTarget.value
                                    setLaneBriefDrafts(prev => ({ ...prev, [lane]: val }))
                                  }}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' && draft.trim()) replaceLane(draft)
                                  }}
                                />
                                <button
                                  type="button"
                                  className="set-reset"
                                  disabled={disabled || !draft.trim()}
                                  onClick={() => {
                                    if (draft.trim()) replaceLane(draft)
                                  }}
                                >
                                  {t('set.verify.apply')}
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className="set-clear set-verify-remove"
                              aria-label={t('set.verify.brief.remove', { lane: laneTitle(lane) })}
                              disabled={disabled}
                              onClick={() =>
                                saveBrief(
                                  defaultBriefPath,
                                  laneBriefEntries.filter(([l]) => l !== lane),
                                )
                              }
                            >
                              <CrossIcon />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    {unconfiguredBriefLanes.length > 0 && (
                      <div className="set-verify-list-row">
                        <span className="set-verify-dev">{t('set.verify.brief.perLane')}</span>
                        <select
                          className="set-select"
                          aria-label={t('set.verify.brief.addLane')}
                          disabled={disabled}
                          value=""
                          onChange={e => {
                            const lane = e.currentTarget.value
                            if (!lane) return
                            saveBrief(defaultBriefPath, [...laneBriefEntries, [lane, VERIFY_CODE_CHECKLIST]])
                          }}
                        >
                          <option value="">{t('set.verify.brief.addLane')}</option>
                          {unconfiguredBriefLanes.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Limits */}
              <div className="set-verify-field">
                <div className="set-verify-limits">
                  <div className="set-verify-limit">
                    <div className="set-lbl">
                      <b>{t('set.verify.limitMin')}</b>
                      <small>{t('set.verify.limitMin.note', { n: defaults.limitMin })}</small>
                    </div>
                    <div className="set-inline">
                      <input
                        type="number"
                        className="set-input set-input-num"
                        aria-label={t('set.verify.limitMin')}
                        min={1}
                        max={VERIFY_LIMIT_MIN_MAX}
                        step={1}
                        disabled={disabled}
                        placeholder={String(defaults.limitMin)}
                        value={limitMinDraft}
                        onChange={e => setLimitMinDraft(e.currentTarget.value)}
                        onBlur={commitLimitMin}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitLimitMin()
                        }}
                      />
                      {settings.limitMin !== null && (
                        <button
                          type="button"
                          className="set-clear"
                          disabled={disabled}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            setSaveError(null)
                            void savePatch({ limitMin: null })
                          }}
                        >
                          {t('set.verify.clear')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="set-verify-limit">
                    <div className="set-lbl">
                      <b>{t('set.verify.max')}</b>
                      <small>{t('set.verify.max.note', { n: defaults.max })}</small>
                    </div>
                    <div className="set-inline">
                      <input
                        type="number"
                        className="set-input set-input-num"
                        aria-label={t('set.verify.max')}
                        min={1}
                        max={VERIFY_MAX_LIMIT}
                        step={1}
                        disabled={disabled}
                        placeholder={String(defaults.max)}
                        value={maxDraft}
                        onChange={e => setMaxDraft(e.currentTarget.value)}
                        onBlur={commitMax}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitMax()
                        }}
                      />
                      {settings.max !== null && (
                        <button
                          type="button"
                          className="set-clear"
                          disabled={disabled}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            setSaveError(null)
                            void savePatch({ max: null })
                          }}
                        >
                          {t('set.verify.clear')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

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
