// The steps by hand, for a server the board does not do (the simple-setup spec's call 10), folded
// in "On the server" under "Your server needs steps by hand" and never shown for a server the
// board sets up itself: the web server's steps as commands the owner pastes on the server, each
// with Copy, why, what to check after and how to undo it. For another board's setup on the
// server, that setup's Undo; else (Call 28) for the case the owner picks and the distribution, its
// unknowns as `<placeholders>`, each with the command that finds it (models/server-setup.ts
// manualOf). The board's own login on the server comes first, as step 1's snippets (Snippets.tsx).
// It sends nothing.
import type { AccessView } from '../../../../src/core/access.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type Distro,
  distroOf,
  manualOf,
  PICKS,
  SERVER_IDLE,
  type SetupState,
  textLine,
} from '../../models/server-setup.ts'
import { classNames } from '../class-names.ts'
import { CopyButton, Paste } from './Snippets.tsx'

export interface DoItMyselfProps {
  view: AccessView
  state: SetupState
  onState(patch: Partial<SetupState>): void
}

const DISTROS: readonly { id: Distro; name: string }[] = [
  { id: 'debian', name: 'Debian' },
  { id: 'ubuntu', name: 'Ubuntu' },
]

export function DoItMyself({ view, state, onState }: DoItMyselfProps) {
  const t = useT()
  const s = view.server ?? SERVER_IDLE
  const manual = manualOf(s, view.tunnel.settings, state)
  const distro = distroOf(s, state)
  const group = PICKS.find(g => g.cases.includes(state.pick))
  return (
    <div className="access-myself">
      <h4 className="access-sub">{t('server.panel.web')}</h4>
      {manual.picker && (
        <div className="access-picker">
          <p className="access-note">{t('server.panel.pickCase')}</p>
          <div className="access-actions">
            {PICKS.map(g => (
              <button
                type="button"
                key={g.id}
                className={classNames('button', 'access-pick', g === group && 'primary')}
                onClick={() => onState({ pick: g.cases[0] ?? state.pick })}
              >
                {t(`server.panel.pick.${g.id}`)}
              </button>
            ))}
          </div>
          {group && group.cases.length > 1 && (
            <div className="access-actions">
              {group.cases.map(c => (
                <button
                  type="button"
                  key={c}
                  className={classNames('button', 'access-variant', c === state.pick && 'primary')}
                  onClick={() => onState({ pick: c })}
                >
                  {t(`server.panel.variant.${c}`)}
                </button>
              ))}
            </div>
          )}
          <div className="access-actions">
            <span className="access-name">{t('server.panel.distro')}</span>
            {DISTROS.map(d => (
              <button
                type="button"
                key={d.id}
                className={classNames('button', 'access-distro', d.id === distro && 'primary')}
                onClick={() => onState({ distro: d.id })}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {manual.error && <p className="access-why">{manual.error}</p>}
      {manual.finders.length > 0 && (
        <>
          <p className="access-note">{t('server.panel.placeholders')}</p>
          <ul className="access-finders">
            {manual.finders.map(f => (
              <li className="access-finder" key={f.placeholder}>
                <code className="access-code">{f.placeholder}</code>
                <code className="access-code">{f.command}</code>
                <CopyButton text={f.command} />
              </li>
            ))}
          </ul>
        </>
      )}
      <ol className="access-blocks">
        {manual.blocks.map((b, i) => (
          <li className="access-block" key={`${b.title.key} ${b.commands}`}>
            <p className="access-block-title">{`${i + 1}. ${textLine(b.title, t)}`}</p>
            <p className="access-block-why">{textLine(b.why, t)}</p>
            {b.commands && <Paste text={b.commands} />}
            {b.check && (
              <>
                <p className="access-note">{t('server.panel.check')}</p>
                <Paste text={b.check} />
              </>
            )}
            {b.undo && (
              <>
                <p className="access-note">{t('server.panel.undoIt')}</p>
                <Paste text={b.undo} />
              </>
            )}
          </li>
        ))}
      </ol>
      <p className="access-note">{t('server.panel.manualEnd')}</p>
    </div>
  )
}
