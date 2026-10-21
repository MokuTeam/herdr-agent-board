// What the owner sets up on the server, filled in from the tunnel's settings (models/access.ts
// serverSnippets, core/tunnel-snippets.ts), each with Copy: the tunnel's user and the socket's
// folder, the keys file's line, the sshd Match block and the Caddyfile; nginx folded away. The
// board never touches the server itself.
import type { TunnelConfig } from '../../../../src/core/tunnel.ts'
import type { Translator } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { serverSnippets } from '../../models/access.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

/** The text on the clipboard, and a toast that says so (or why not). */
async function copy(text: string, t: Translator, toast: (text: string, error?: boolean) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('access.copied'))
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true)
  }
}

/** Copy for a text the panel shows; it needs no board, so it works while the board is away too. */
export function CopyButton({ text }: { text: string }) {
  const t = useT()
  const { toast } = useBoardContext()
  return (
    <button type="button" className="button access-copy" onClick={() => void copy(text, t, toast)}>
      {t('access.copy')}
    </button>
  )
}

interface SnippetProps {
  title: string
  text: string
  open: boolean
  /** A line before the text. */
  note?: string
}

function Snippet({ title, text, open, note }: SnippetProps) {
  return (
    <details className="access-snippet" open={open}>
      <summary className="access-summary">{title}</summary>
      {note && <p className="access-note">{note}</p>}
      <pre className="access-pre">
        <code>{text}</code>
      </pre>
      <CopyButton text={text} />
    </details>
  )
}

export function Snippets({ settings, publicKey }: { settings: TunnelConfig; publicKey: string | null }) {
  const t = useT()
  const s = serverSnippets(settings, publicKey)
  return (
    <div className="access-snippets">
      <h3 className="access-head">{t('access.snippets')}</h3>
      <Snippet title={t('access.snip.commands')} text={s.commands} open />
      <Snippet title={t('access.snip.keys', { file: s.keysFile })} text={s.keysLine} open />
      <Snippet title={t('access.snip.sshd')} text={s.sshd} open />
      <Snippet title={t('access.snip.caddy')} text={s.caddy} open />
      <Snippet title={t('access.snip.nginx')} text={s.nginx} open={false} note={t('access.snip.nginxNote')} />
    </div>
  )
}
