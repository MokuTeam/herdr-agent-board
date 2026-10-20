// A lane's "+ folder" in the categories panel: the new-session window's folder field
// (launch/folder-field.ts), with its completion, the mark that says whether the folder is there,
// its suggestions while it is empty (models/categories.ts laneSuggestions) and the columns to
// browse. Enter, or a folder chosen in the columns, adds the folder to the lane, as the server
// resolved it, once the server says it is a folder there; the field is then empty for the next
// one. A folder not there is not added: the note under the field says why. Escape closes the list,
// then the columns, then empties the field and leaves it; it never closes the panel. What it draws
// is the row's (CategoryRow.tsx).
import type { BoardCategory } from '../../../../src/core/payload.ts'
import type { Translator } from '../../../../src/core/types.ts'
import type { LaunchApi } from '../../api/launch.ts'
import { type FolderSources, laneSuggestions, withPath } from '../../models/categories.ts'
import { suggestionItems } from '../../models/launch.ts'
import { Store } from '../../state/store.ts'
import { type FieldKey, type FieldNote, folderField, NO_NOTE } from '../launch/folder-field.ts'
import type { CategoryEdit } from './CategoryRow.tsx'

export interface LaneFolderDeps {
  t(): Translator
  dirs: LaunchApi['dirs']
  /** The lane as the board has it now. */
  category(): BoardCategory
  /** What its suggestions come from. */
  folders(): FolderSources
  edit: CategoryEdit
  /** The field, the columns, a row: in the drawn row. */
  find(selector: string): HTMLElement | null
}

/** The field's own part of the row as drawn; the rest is the folder field's FolderView. */
export interface LaneFolderView {
  /** Under the field: why a folder was not added. */
  note: FieldNote
  /** Bumped when work waits for the next draw. */
  seq: number
}

export function laneFolder(deps: LaneFolderDeps) {
  const view = new Store<LaneFolderView>({ note: NO_NOTE, seq: 0 })
  const waiting: (() => void)[] = []
  const field = () => deps.find('input[name="cwd"]')

  const folder = folderField({
    id: `cat-${deps.category().id}`,
    t: () => deps.t(),
    dirs: (path, git) => deps.dirs(path, git),
    // A lane's field is there as long as its row.
    live: () => true,
    suggestions: () => suggestionItems(laneSuggestions(deps.category(), deps.folders()), deps.t()),
    apply(path) {
      folder.setText(path)
      folder.checkFolder()
    },
    checked() {},
    note: text => view.set({ ...view.get(), note: { text, hidden: !text, error: !!text } }),
    sync() {},
    submit: () => void add(),
    chosen() {
      field()?.focus()
      void add()
    },
    later(fn) {
      waiting.push(fn)
      view.set({ ...view.get(), seq: view.get().seq + 1 })
    },
    find: deps.find,
  })
  const text = () => folder.view.get().text

  /** Empty again: nothing typed, marked, listed or browsed. */
  function clear(): void {
    folder.setText('')
    folder.clearState()
    folder.closePop()
    folder.closeBrowse()
  }

  /** The folder in the field goes to the lane once the server says it is a folder there. */
  async function add(): Promise<void> {
    const typed = text().trim()
    if (!typed) return
    // Enter can come before the folder was checked: check it now, then go on with that answer.
    if (folder.check()?.input !== typed) {
      await folder.runCheck(typed)
      if (text().trim() !== typed) return
    }
    // Not there, a file, no answer: the note says so, and the field keeps it to be put right.
    const check = folder.check()
    if (!check?.exists || !check.dir) return
    const c = deps.category()
    // As the server resolved it (~ at home, the folder's own case), so the lane's sessions match it.
    const paths = withPath(c, check.path || typed)
    clear()
    if (paths) await deps.edit({ op: 'update', id: c.id, paths })
  }

  /** Esc: the list first, then the columns, then the field empties and is left; the panel stays. */
  function escapeKey(e: Pick<FieldKey, 'stopPropagation'>): void {
    e.stopPropagation()
    if (folder.escape()) return
    clear()
    field()?.blur()
  }

  return {
    view,
    folder,
    /** After every draw: work that waited for the draw is done. */
    afterDraw(): void {
      for (const fn of waiting.splice(0)) fn()
    },

    // The field's and the columns' events: the folder field's, Escape the lane's own.
    input: folder.input,
    /** Answers are asked anew each time the field is entered: a folder made since is there. */
    focus(): void {
      folder.reset()
      folder.focus()
    },
    blur: folder.blur,
    key(e: FieldKey): void {
      if (e.key === 'Escape' && !e.isComposing) escapeKey(e)
      else folder.key(e)
    },
    takePop: folder.takePop,
    toggleBrowse: folder.toggleBrowse,
    pickRow: folder.pickRow,
    chooseRow: folder.chooseRow,
    rowKey(e: Pick<FieldKey, 'key' | 'preventDefault' | 'stopPropagation'>, col: number, row: number): void {
      if (e.key === 'Escape') escapeKey(e)
      else folder.rowKey(e, col, row)
    },
  }
}

export type LaneFolder = ReturnType<typeof laneFolder>
