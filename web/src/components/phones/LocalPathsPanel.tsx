// Paths on this computer, opened from Settings on the board seen from another device
// (models/remote-page.ts): the server's folders and where each is here, through a shared drive.
// Every change is kept in this browser at once (state/local-paths.ts); the quick look copies a
// file's path here from it (models/local-paths.ts localPath).
import { useT } from '../../i18n/I18nProvider.tsx'
import { type PathMap, SERVER_ROOT } from '../../models/local-paths.ts'
import { keepLocalPaths, localPaths, suggestion } from '../../state/local-paths.ts'
import { useStore } from '../../state/store.ts'
import { Panel } from '../panel/Panel.tsx'

export interface LocalPathsPanelProps {
  open: boolean
  onClose(): void
}

export function LocalPathsPanel({ open, onClose }: LocalPathsPanelProps) {
  const t = useT()
  const maps = useStore(localPaths())
  const suggested = suggestion()
  const change = (i: number, side: keyof PathMap, value: string) =>
    keepLocalPaths(maps.map((m, j) => (j === i ? { ...m, [side]: value } : m)))
  return (
    <Panel
      id="paths-sheet"
      kind="paths"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('paths.title')}</h2>
          <p className="sheet-meta">{t('paths.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body local-paths">
        {maps.length === 0 && <p className="sheet-meta">{t('paths.none')}</p>}
        {maps.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows in their order, edited in place
          <div className="local-path" key={i}>
            <input
              value={m.server}
              placeholder={SERVER_ROOT}
              spellCheck={false}
              aria-label={t('paths.server')}
              title={t('paths.server')}
              onChange={e => change(i, 'server', e.currentTarget.value)}
            />
            <span aria-hidden="true">→</span>
            <input
              value={m.local}
              placeholder={suggested[0]?.local ?? 'Z:\\'}
              spellCheck={false}
              aria-label={t('paths.local')}
              title={t('paths.local')}
              onChange={e => change(i, 'local', e.currentTarget.value)}
            />
            <button
              type="button"
              className="icon-button"
              title={t('paths.remove')}
              aria-label={t('paths.remove')}
              onClick={() => keepLocalPaths(maps.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <div className="local-paths-actions">
          <button
            type="button"
            className="button"
            onClick={() => keepLocalPaths([...maps, { server: suggested[0]?.server ?? SERVER_ROOT, local: '' }])}
          >
            {t('paths.add')}
          </button>
          {suggested.length > 0 && (
            <button type="button" className="button" onClick={() => keepLocalPaths(suggested)}>
              {t('paths.suggest')}
            </button>
          )}
        </div>
      </div>
    </Panel>
  )
}
