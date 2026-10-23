// Step 1 of "On the server", by hand: what gives the tunnel its rights on the server, filled in from
// the tunnel's settings (models/access.ts serverSnippets, core/tunnel-snippets.ts), each with Copy:
// all of step 1 in one paste (folded, once there is a key to write), the tunnel's user and the
// socket's folder, the keys file's line, the sshd Match block. These stay the owner's to paste: the
// board never runs them itself. The web server in front of the tunnel is step 3's (ServerSetup.tsx).
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

/** A text to paste, with its Copy. */
export function Paste({ text }: { text: string }) {
  return (
    <>
      <pre className="access-pre">
        <code>{text}</code>
      </pre>
      <CopyButton text={text} />
    </>
  )
}

interface SnippetProps {
  title: string
  /** null: nothing to paste yet (the note says why). */
  text: string | null
  open: boolean
  /** A line before the text. */
  note?: string
}

function Snippet({ title, text, open, note }: SnippetProps) {
  return (
    <details className="access-snippet" open={open}>
      <summary className="access-summary">{title}</summary>
      {note && <p className="access-note">{note}</p>}
      {text !== null && <Paste text={text} />}
    </details>
  )
}

export function Snippets({ settings, publicKey }: { settings: TunnelConfig; publicKey: string | null }) {
  const t = useT()
  const s = serverSnippets(settings, publicKey)
  return (
    <div className="access-snippets">
      <Snippet
        title={t('access.snip.paste')}
        text={s.paste}
        open={false}
        note={s.paste === null ? t('access.snip.pasteNoKey') : t('access.snip.pasteNote')}
      />
      <Snippet title={t('access.snip.commands')} text={s.commands} open />
      <Snippet title={t('access.snip.keys', { file: s.keysFile })} text={s.keysLine} open />
      <Snippet title={t('access.snip.sshd')} text={s.sshd} open />
    </div>
  )
}
