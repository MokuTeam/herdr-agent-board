import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import {
  baseName,
  categoryForDir,
  checkBranch,
  checkName,
  checkWorkspaceName,
  completions,
  defaultWorkspace,
  folderSuggestions,
  forkName,
  isAbsolutePath,
  kebabName,
  NAME_MAX,
  sameDir,
  sessionWorkspace,
  slugName,
  splitPathInput,
  suggestName,
  ticketSlugName,
  uniqueSlug,
  worktreePath,
} from '../../src/core/launch/names.ts'

beforeEach(() => {
  useLanguage('en')
})

test('session names: what a name may be, and herdr’s name for it', () => {
  assert.equal(checkName('Acme invoices'), '')
  assert.equal(checkName('Ромашка 2'), '')
  assert.equal(checkName('  '), 'launch.err.nameEmpty')
  assert.equal(checkName('x'.repeat(61)), 'launch.err.nameLong')
  assert.equal(checkName('two\nlines'), 'launch.err.nameChars')
  // C1 controls, line separators, and bidi overrides that make a name read as something else.
  for (const c of ['\u0085', '\u009b', '\u2028', '\u2029', '\u202e', '\u2066', '\u2069'])
    assert.equal(checkName(`a${c}b`), 'launch.err.nameChars', String(c.codePointAt(0)?.toString(16)))
  assert.equal(checkName('-Workspace w1'), 'launch.err.nameStart') // would read as an option
  assert.equal(checkName('/clear'), 'launch.err.nameStart') // would read as a Claude command
  assert.equal(slugName('Acme-Invoices'), 'acme-invoices')
  assert.equal(slugName('Ромашка: счета'), 'romashka-scheta')
  assert.equal(slugName('2026 plan'), 's-2026-plan')
  assert.equal(slugName('14404'), 's-14404')
  assert.equal(ticketSlugName('14404'), 'case-14404')
  assert.equal(ticketSlugName('EA-17388'), 'ea-17388')
  assert.equal(slugName('!!!'), 'session')
  assert.match(slugName('a'.repeat(50)), /^[a-z][a-z0-9_-]{0,31}$/)
  assert.equal(uniqueSlug('job', new Set()), 'job')
  assert.equal(uniqueSlug('job', new Set(['job', 'job-2'])), 'job-3')
  assert.equal(uniqueSlug('a'.repeat(32), new Set(['a'.repeat(32)])).length, 32)
})

test('a name in kebab-case, for a new workspace: lower case, letters and digits of any script, one dash between', () => {
  assert.equal(kebabName('New Test Project'), 'new-test-project')
  assert.equal(kebabName('herdr-agent-board 2'), 'herdr-agent-board-2')
  assert.equal(kebabName('Новый проект'), 'новый-проект')
  assert.equal(kebabName('  Acme: invoices (March)!  '), 'acme-invoices-march')
  assert.equal(kebabName('--snake_case--and  spaces'), 'snake-case-and-spaces')
  // Accents typed apart are put together; the marks of a script stay with their letters.
  assert.equal(kebabName('Café Ü'), 'café-ü')
  assert.equal(kebabName('हिंदी नोट्स'), 'हिंदी-नोट्स')
  assert.equal(kebabName('!!! ???'), '')
  assert.equal(kebabName(''), '')
  // Cut at 40, as herdr's workspace names are: no dash or half a character left at the end.
  assert.equal(kebabName('a'.repeat(50)), 'a'.repeat(40))
  assert.equal(kebabName(`${'a'.repeat(39)} b`), 'a'.repeat(39))
  assert.equal(kebabName(`${'a'.repeat(39)}𝒜`), 'a'.repeat(39))
})

test('workspace names: what herdr takes as one, a slash first as well', () => {
  assert.equal(checkWorkspaceName('Billing'), '')
  assert.equal(checkWorkspaceName(' Ромашка 2 '), '')
  assert.equal(checkWorkspaceName('/srv work'), '')
  assert.equal(checkWorkspaceName('x'.repeat(60)), '')
  assert.equal(checkWorkspaceName('  '), 'rename.err.workspaceEmpty')
  assert.equal(checkWorkspaceName(null), 'rename.err.workspaceEmpty')
  assert.equal(checkWorkspaceName('x'.repeat(61)), 'launch.err.nameLong')
  assert.equal(checkWorkspaceName('two\nlines'), 'launch.err.nameChars')
  assert.equal(checkWorkspaceName('a‮b'), 'launch.err.nameChars')
  assert.equal(checkWorkspaceName('--help'), 'rename.err.workspaceDash') // would read as an option
})

test('folders: absolute paths, completion, the lane a folder falls in', () => {
  assert.ok(isAbsolutePath('C:\\Work'))
  assert.ok(isAbsolutePath('/home/me'))
  assert.ok(isAbsolutePath('~/x'))
  assert.ok(isAbsolutePath('\\\\server\\share'))
  assert.ok(!isAbsolutePath('Work\\x'))
  assert.ok(sameDir('C:\\Work\\X\\', 'c:/work/x'))
  assert.equal(baseName('C:\\Work\\Acme\\'), 'Acme')
  assert.deepEqual(splitPathInput('C:\\Work\\Pe'), { dir: 'C:\\Work\\', prefix: 'Pe', sep: '\\' })
  assert.deepEqual(splitPathInput('/home/me/'), { dir: '/home/me/', prefix: '', sep: '/' })
  assert.deepEqual(splitPathInput('C:'), { dir: '', prefix: 'C:', sep: '\\' })
  // Names that start with it first, then names that contain it; dot folders only when asked for.
  assert.deepEqual(completions(['Personal', '.git', 'Apps', 'People', 'Shared-pe'], 'pe'), [
    'Personal',
    'People',
    'Shared-pe',
  ])
  assert.deepEqual(completions(['.git', '.github', 'src'], '.g'), ['.git', '.github'])
  assert.deepEqual(completions(['b', 'a'], ''), ['b', 'a'])
  const cats = [
    { id: 'acme', paths: ['C:\\Clients'] },
    { id: 'globex', paths: ['C:\\Clients\\Globex'] },
  ]
  assert.equal(categoryForDir(cats, 'c:/clients/globex/app'), 'globex')
  assert.equal(categoryForDir(cats, 'C:\\Clients\\Initech'), 'acme')
  assert.equal(categoryForDir(cats, 'C:\\ClientsX'), null)
})

test('the window’s defaults: folders by context, a free name, the lane’s workspace', () => {
  const categories = [
    { id: 'acme', title: 'Acme', paths: ['C:\\Acme'] },
    { id: 'other', title: 'Other', paths: [] },
  ]
  const items = [
    { name: 'acme-api', cwd: 'C:\\Acme\\api', category: 'acme', workspace: 'Acme', activity: 2 },
    { name: 'acme-web', cwd: 'C:\\Acme\\web', category: 'acme', workspace: 'Acme', activity: 3 },
    { name: 'misc', cwd: 'D:\\misc', category: 'other', workspace: 'Work', activity: 9 },
    {
      name: 'probe',
      cwd: 'C:\\Users\\me\\AppData\\Local\\Temp\\scratch\\probe',
      category: 'other',
      workspace: 'Work',
      activity: 10,
    },
  ]
  const s = folderSuggestions({
    context: { cwd: 'C:\\Acme\\api', category: 'acme' },
    categories,
    items,
    recent: ['E:\\recent', 'c:/acme/web'],
  })
  assert.deepEqual(
    s.map(x => x.path),
    ['C:\\Acme\\api', 'C:\\Acme', 'C:\\Acme\\web', 'E:\\recent', 'D:\\misc'],
  )
  assert.deepEqual(
    s.map(x => x.why),
    ['card', 'lane', 'session', 'recent', 'session'],
  )
  assert.equal(suggestName('C:\\Acme\\api', items), 'api')
  assert.equal(suggestName('C:\\x\\acme-api', items), 'acme-api 2')
  const workspaces = [
    { id: 'w1', label: 'Board' },
    { id: 'w2', label: 'Acme' },
    { id: 'w3', label: 'Work' },
    { id: 'w4', label: 'Globex tools' },
  ]
  assert.equal(defaultWorkspace({ category: 'acme', title: 'Acme', items, workspaces, board: 'Board' }), 'w2')
  assert.equal(defaultWorkspace({ category: 'globex', title: 'Globex', items, workspaces, board: 'Board' }), 'w4')
  assert.equal(
    defaultWorkspace({ category: 'new', title: 'New', items, workspaces, board: 'Board', fallback: 'w3' }),
    'w3',
  )
  // The board's own workspace is never the default, and no fit means a new one.
  assert.equal(
    defaultWorkspace({ category: 'new', title: 'New', items, workspaces, board: 'Board', fallback: 'w1' }),
    '',
  )
})

test('worktrees: branch names git takes, and the ticket folder they go to', () => {
  assert.equal(checkBranch('feature/menu'), '')
  assert.equal(checkBranch(''), 'launch.err.branchEmpty')
  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'a/', '.hidden', 'a@{1}'])
    assert.equal(checkBranch(bad), 'launch.err.branch', bad)
  assert.equal(worktreePath('C:\\Work\\agent-board', 'new-session'), 'C:\\Work\\agent-board-new-session')
  assert.equal(worktreePath('/src/app/', 'feature/menu'), '/src/app-feature-menu')
  assert.equal(worktreePath('C:\\Work\\agent-board', 'new-session', true), 'C:\\Work\\agent-board-wt\\new-session')
  assert.equal(worktreePath('/src/app/', 'feature/menu', true), '/src/app-wt/feature-menu')
  assert.equal(worktreePath('/src/Genetix', 'case_14404', true), '/src/Genetix-wt/14404')
  assert.equal(worktreePath('/src/BrillianEarth', 'EA-17388', true), '/src/BrillianEarth-wt/EA-17388')
})

test('a fork’s name: the session’s with the mark after it, within the limit, without what a name may not start with', () => {
  assert.equal(forkName('Acme invoices', 'fork'), 'Acme invoices · fork')
  assert.equal(forkName('Счета', 'форк'), 'Счета · форк')
  const long = forkName('x'.repeat(80), 'fork')
  assert.equal(long.length, NAME_MAX)
  assert.ok(long.endsWith(' · fork'))
  assert.equal(forkName('/rename me', 'fork'), 'rename me · fork')
  assert.equal(forkName('', 'fork'), 'session · fork')
  assert.equal(checkName(forkName('-x\u0007', 'fork')), '')
})

test('where a session goes back to, or its fork goes: its workspace by id and name, by name, its lane’s, a new one', () => {
  const workspaces = [
    { id: 'w1', label: 'Acme' },
    { id: 'w2', label: 'Board' },
    { id: 'w3', label: 'Personal' },
  ]
  const base = { category: 'acme', title: 'Acme', workspaces, board: 'Board' }
  assert.deepEqual(sessionWorkspace({ ...base, workspaceId: 'w1', workspace: 'Acme' }), { id: 'w1', label: 'Acme' })
  assert.deepEqual(sessionWorkspace({ ...base, workspace: 'Personal' }), { id: 'w3', label: 'Personal' })
  // Never the board's own: the lane's default instead.
  assert.deepEqual(sessionWorkspace({ ...base, workspace: 'Board' }), { id: 'w1', label: 'Acme' })
  // Gone, and no lane default: a new one named like it.
  assert.deepEqual(sessionWorkspace({ ...base, title: 'Other', category: 'other', workspace: 'Old' }), {
    create: 'Old',
  })
  assert.deepEqual(sessionWorkspace({ ...base, title: '', category: 'other', workspace: null }), { create: 'Sessions' })
})
