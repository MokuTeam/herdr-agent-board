import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { FormQuestion } from '../../src/core/dialogs/question-form.ts'
import {
  type AnswerPick,
  answerText,
  arrows,
  type Dialog,
  onQuestion,
  type PermissionDialog,
  parseDialog,
  publicDialog,
  type QuestionDialog,
  questionsOf,
  type ReviewDialog,
  resolveAnswers,
  reviewMatches,
  sameText,
  screenIndex,
  tooTall,
  typedOther,
} from '../../src/core/dialogs/questions.ts'
import { drivePermission, driveQuestions } from '../../src/services/answer.ts'
import { FakeDialog } from '../support/fake-dialog.ts'

// A checkout with core.autocrlf turns the screens into CRLF; herdr gives LF.
const screen = (name: string) =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value')
  return v
}
const form = (input: unknown): FormQuestion[] => must(questionsOf(input))
const first = (qs: FormQuestion[]): FormQuestion => must(qs[0])
const asQuestion = (d: Dialog | null): QuestionDialog => {
  assert.equal(d?.kind, 'question')
  return d as QuestionDialog
}
const asReview = (d: Dialog | null): ReviewDialog => {
  assert.equal(d?.kind, 'review')
  return d as ReviewDialog
}
const asPermission = (d: Dialog | null): PermissionDialog => {
  assert.equal(d?.kind, 'permission')
  return d as PermissionDialog
}
const picksOf = (qs: FormQuestion[], answers: unknown): AnswerPick[] => {
  const r = resolveAnswers(qs, answers)
  if ('error' in r) throw new Error(r.error)
  return r.picks
}
const errorOf = (qs: FormQuestion[], answers: unknown): string | undefined => {
  const r = resolveAnswers(qs, answers)
  return 'error' in r ? r.error : undefined
}
const fast = { timeout: 200, every: 1 }
// Claude's input box and no dialog: the screen once a dialog is answered.
const IDLE = ['● Done.', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ manual mode on'].join('\n')

// The questions the screens in support/screens were taken from.
const COLOR = form({
  questions: [
    {
      question: 'Which color should the test widget use?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm red, good for alerts' },
        { label: 'Green', description: 'Calm green for success states' },
        { label: 'Blue', description: 'Neutral blue, the default' },
      ],
    },
  ],
})
const ORDER = form({
  questions: [
    {
      question: 'Which size?',
      header: 'Size',
      multiSelect: false,
      options: [
        { label: 'Small', description: 'Fits a phone' },
        { label: 'Large', description: 'Fits a desktop' },
      ],
    },
    {
      question: 'Which toppings?',
      header: 'Toppings',
      multiSelect: true,
      options: [
        { label: 'Cheese', description: 'Melted on top' },
        { label: 'Olives', description: 'Black, sliced' },
        { label: 'Basil', description: 'Fresh leaves' },
      ],
    },
    { question: 'Deliver when?', header: 'When', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
  ],
})
const PLATFORMS = form({
  questions: [
    {
      question: 'Which platforms should the build target?',
      header: 'Platforms',
      multiSelect: true,
      options: [
        { label: 'Windows', description: 'x64 installer' },
        { label: 'macOS', description: 'Universal binary' },
        { label: 'Linux', description: 'AppImage and deb' },
      ],
    },
  ],
})
const LAYOUT = form({
  questions: [
    {
      question: 'Which layout for the settings page?',
      header: 'Layout',
      multiSelect: false,
      options: [
        { label: 'Sidebar', description: 'Nav on the left', preview: '+--+\n|  |' },
        { label: 'Tabs', description: 'Tabs on top', preview: '+----+' },
      ],
    },
  ],
})
// The question-cut-* screens: Claude Code 2.1.323 in panes too short for it (112 × 20, 60 × 32,
// 50 × 30 and 50 × 20 cells), its bottom kept in view.
const PHOTOS = form({
  questions: [
    {
      question:
        'Spring clean-up of the shared photo library (1300 pictures, all of them already in the family album). Cleo asked for a zip of the originals before anything is deleted, but the library is not mounted on this machine and the sync tool hands out one picture at a time. How do we keep a copy?',
      header: 'Photos',
      multiSelect: false,
      options: [
        {
          label: 'Move them to an archive folder (Recommended)',
          description:
            'I make a folder beside the library (\\PHOTOS_archive_spring) and move the 1300 pictures there instead of deleting them. They leave the library, stay exactly as they are, and can be moved back. We remove the folder later with a separate OK. Downside: one more folder in the library, ben should know about it.',
        },
        {
          label: 'Delete them, keep a list',
          description:
            'anna says she can sync them again if needed, the album has them all. I delete them as planned, and the copy keeps only a list (name, size, date taken), without the pictures. Cannot be undone.',
        },
        {
          label: 'A one-off export job for the zip',
          description:
            'I set up a one-off export job that pulls every picture, build the zip on this machine, then delete the pictures and the job. Exactly what cleo asked for, but one more job to clean up and about an hour of work.',
        },
      ],
    },
  ],
})
// The question-review-bar screen: Claude Code 2.1.323, 112 cells wide.
const CLUB = form({
  questions: [
    {
      question:
        'The reminder bot for the book club runs (both calendars look fine, nothing is overdue right now), but its message step has never fired yet. Check it with a test message?',
      header: 'Test',
      multiSelect: false,
      options: [
        {
          label: 'Yes, send a test message (Recommended)',
          description: 'One message to anna in a direct chat, then I say what arrived and when.',
        },
        { label: 'Not needed', description: 'It stays untested until the first real reminder.' },
      ],
    },
    {
      question:
        'Switch the reminders to a schedule (every morning at eight, about thirty runs a month) for the main calendar only, and add the others later?',
      header: 'Schedule',
      multiSelect: false,
      options: [
        {
          label: 'Switch it on now (Recommended)',
          description: 'The main calendar from tomorrow, ben adds the other two next week.',
        },
        { label: 'Not yet', description: 'It waits until all three calendars are ready.' },
      ],
    },
  ],
})
// A question that FakeDialog in a pane of 10 lines cuts into its options: option 1 above the edge.
const TALL = form({
  questions: [
    {
      question: 'Which plan for the old pictures?',
      header: 'Plan',
      multiSelect: false,
      options: [
        { label: 'Move them', description: 'To an archive folder beside the library' },
        { label: 'Delete them', description: 'Keep only a list of what was there' },
        { label: 'Zip them', description: 'Through a one-off export job' },
      ],
    },
  ],
})

test('questionsOf keeps what the form needs and refuses what it cannot answer', () => {
  assert.equal(COLOR.length, 1)
  assert.deepEqual(first(COLOR).options[0], { label: 'Red', description: 'A warm red, good for alerts' })
  assert.equal(first(LAYOUT).preview, true)
  assert.equal(first(PLATFORMS).multiSelect, true)
  assert.equal(questionsOf(null), null)
  assert.equal(questionsOf({ questions: [] }), null)
  assert.equal(questionsOf({ questions: [{ question: 'No options?', options: [] }] }), null)
  assert.equal(
    questionsOf({
      questions: [
        { question: 'Fine', options: [{ label: 'A' }] },
        { question: '', options: [{ label: 'B' }] },
      ],
    }),
    null,
  )
  assert.equal(
    first(form({ questions: [{ question: 'Fine', options: [{ label: 'A', description: 3 }] }] })).options[0]
      ?.description,
    '',
  )
  // Never cut short (the screen would differ): too much, and the terminal answers it.
  const one = (q = 'Q?', options = [{ label: 'A' }, { label: 'B' }]) => ({ question: q, header: 'H', options })
  assert.equal(questionsOf({ questions: [one('x'.repeat(2001))] }), null)
  assert.ok(questionsOf({ questions: [one('x'.repeat(2000))] }))
  assert.equal(questionsOf({ questions: [one('Q?', [{ label: 'y'.repeat(501) }])] }), null)
  assert.equal(questionsOf({ questions: [1, 2, 3, 4, 5].map(n => one(`Q${n}?`)) }), null)
  assert.ok(questionsOf({ questions: [1, 2, 3, 4].map(n => one(`Q${n}?`)) }))
  assert.equal(
    questionsOf({
      questions: [
        one(
          'Q?',
          Array.from({ length: 9 }, (_, i) => ({ label: `O${i}` })),
        ),
      ],
    }),
    null,
  )
  // Answers are keyed by the question's text and picked by an option's label: both must be unique.
  assert.equal(questionsOf({ questions: [one('Same?'), one('Same?')] }), null)
  assert.equal(questionsOf({ questions: [one('Q?', [{ label: 'A' }, { label: 'A' }])] }), null)
})

test('an own answer: one line, no control or direction characters', () => {
  const q = first(form({ questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }))
  const other = (text: string) => picksOf([q], [{ other: text }])[0]?.other
  assert.equal(other(' two\r\nlines\there '), 'two lines here')
  assert.equal(other('a\x1b[31mb\x85c\x9bd'), 'a [31mb c d')
  assert.equal(other('pay\u202etxt.exe\u2066x\u2069'), 'pay txt.exe x')
  assert.equal(other('-1 day'), '-1 day') // the dash is herdr's business (services/answer.ts paneIO)
  assert.equal(other('x'.repeat(1500))?.length, 1000)
})

test('resolveAnswers maps labels to option numbers and checks every question', () => {
  assert.deepEqual(
    picksOf(ORDER, [{ options: ['Large'] }, { options: ['Basil', 'Cheese'] }, { other: ' Tomorrow\nat noon ' }]),
    [
      { choose: [2], other: '' },
      { choose: [1, 3], other: '' },
      { choose: [], other: 'Tomorrow at noon' },
    ],
  )
  const invalid = [
    [{ options: ['Large', 'Small'] }, { options: ['Cheese'] }, { options: ['Now'] }], // two for a single select
    [{ options: ['Large'] }, { options: [] }, { options: ['Now'] }], // nothing for a multiSelect
    [{ options: ['Large'] }, { options: ['Ham'] }, { options: ['Now'] }], // not an option
    [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'], other: 'and later' }], // an option and an own answer
    [{ options: ['Large'] }, { options: ['Cheese'] }], // one missing
  ]
  for (const answers of invalid) assert.equal(errorOf(ORDER, answers), 'err.qa.invalid')
  assert.equal(errorOf(LAYOUT, [{ other: 'Both' }]), 'err.qa.invalid') // no own answer beside previews
  assert.equal(answerText(must(ORDER[1]), { choose: [1, 3], other: 'Ham' }), 'Cheese, Basil, Ham')
})

test('parseDialog reads a lone question as Claude Code draws it', () => {
  const d = asQuestion(parseDialog(screen('question-single')))
  assert.equal(d.kind, 'question')
  assert.equal(d.question, 'Which color should the test widget use?')
  assert.deepEqual(
    d.options.map(o => o.label),
    ['Red', 'Green', 'Blue', 'Type something.'],
  )
  assert.equal(d.options[0]?.text, 'Red A warm red, good for alerts')
  assert.equal(d.cursor, 1)
  assert.equal(d.editing, false)
  assert.ok(onQuestion(d, first(COLOR)))
  assert.equal(typedOther(d), '')
  assert.equal(publicDialog(d)?.kind, 'question')
})

test('parseDialog reads a question Claude Code 2.1.303 draws with a bar before each of its lines', () => {
  const long = form({
    questions: [
      {
        question:
          'Which color should the test widget use when it is shown on a very wide dashboard next to the other widgets that already use most of the palette, so that it still stands out clearly?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'A warm red, good for alerts' },
          { label: 'Green', description: 'Calm green for success states' },
        ],
      },
    ],
  })
  const d = asQuestion(parseDialog(screen('question-single-bar')))
  assert.equal(d.question, first(long).question)
  assert.deepEqual(
    d.options.map(o => o.label),
    ['Red', 'Green', 'Type something.'],
  )
  assert.equal(d.cursor, 1)
  assert.ok(onQuestion(d, first(long)))
  assert.equal(screenIndex(d, long), 0)
  assert.equal(publicDialog(d)?.kind, 'question')
  // Only Claude Code's bar goes: one the question itself starts with stays.
  const own = screen('question-single-bar').replace('│ Which color', '│ │ Which color')
  assert.equal(asQuestion(parseDialog(own)).question, `│ ${first(long).question}`)
  // A screen without the bar on every line (earlier Claude Code) is read as it is.
  const once = screen('question-single-bar').replace('│ stands out', 'stands out')
  assert.ok(asQuestion(parseDialog(once)).question.startsWith('│ Which color'))
})

test('parseDialog follows the tabs of several questions', () => {
  const tab1 = asQuestion(parseDialog(screen('question-tabs-1')))
  assert.deepEqual(tab1.tabs, [
    { header: 'Size', answered: false },
    { header: 'Toppings', answered: false },
    { header: 'When', answered: false },
  ])
  assert.equal(screenIndex(tab1, ORDER), 0)
  const multi = asQuestion(parseDialog(screen('question-tabs-2-multi')))
  assert.equal(screenIndex(multi, ORDER), 1)
  assert.deepEqual(
    multi.options.map(o => o.checked),
    [false, false, false, false],
  )
  assert.deepEqual(multi.next, { label: 'Next', cursor: false })
  const other = asQuestion(parseDialog(screen('question-tabs-3-other')))
  assert.equal(screenIndex(other, ORDER), 2)
  assert.equal(other.cursor, 3)
  assert.equal(other.editing, true)
  const typed = asQuestion(parseDialog(screen('question-tabs-3-typed')))
  assert.equal(typedOther(typed), 'Tomorrow at noon')
  const review = asReview(parseDialog(screen('question-review')))
  assert.equal(review.kind, 'review')
  assert.equal(screenIndex(review, ORDER), 3)
  assert.deepEqual(
    review.answers.map(a => a.answer),
    ['Large', 'Cheese, Basil', 'Tomorrow at noon'],
  )
  assert.ok(
    reviewMatches(review, ORDER, [
      { choose: [2], other: '' },
      { choose: [1, 3], other: '' },
      { choose: [], other: 'Tomorrow at noon' },
    ]),
  )
  assert.ok(
    !reviewMatches(review, ORDER, [
      { choose: [1], other: '' },
      { choose: [1, 3], other: '' },
      { choose: [], other: 'Tomorrow at noon' },
    ]),
  )
})

test('parseDialog reads a lone multiSelect question and one with previews', () => {
  const multi = asQuestion(parseDialog(screen('question-lone-multi')))
  assert.ok(onQuestion(multi, first(PLATFORMS)))
  assert.deepEqual(multi.next, { label: 'Submit', cursor: false })
  const preview = asQuestion(parseDialog(screen('question-preview')))
  assert.equal(preview.preview, true)
  assert.deepEqual(
    preview.options.map(o => o.label),
    ['Sidebar', 'Tabs'],
  )
  assert.ok(onQuestion(preview, first(LAYOUT)))
  assert.ok(!onQuestion(preview, first(COLOR)))
})

test('parseDialog reads permission prompts, with a fingerprint that changes with the prompt', () => {
  const bash = asPermission(parseDialog(screen('permission-bash')))
  assert.equal(bash.kind, 'permission')
  assert.equal(bash.title, 'Bash command')
  assert.deepEqual(bash.body, ['Write hello into a probe note file', 'echo hello > probe-note.txt'])
  assert.equal(bash.prompt, 'Do you want to proceed?')
  assert.equal(bash.options.length, 4)
  // A wrapped choice reads as the terminal broke it: a path broken mid-word gets no space in it.
  assert.match(bash.options[1]?.text ?? '', /\\of\\pro\nbe from this project$/)
  assert.equal(bash.options[3]?.text, 'No')
  assert.equal(bash.cursor, 1)
  const write = asPermission(parseDialog(screen('permission-write')))
  assert.equal(write.title, 'Create file')
  assert.equal(write.prompt, 'Do you want to create probe-two.txt?')
  assert.deepEqual(
    write.options.map(o => o.n),
    [1, 2, 3],
  )
  assert.match(write.options[1]?.text ?? '', /for this session\n\(shift\+tab\)$/) // broken at a space
  assert.notEqual(write.fingerprint, bash.fingerprint)
  assert.equal(asPermission(parseDialog(screen('permission-bash'))).fingerprint, bash.fingerprint)
  const command = (c: string) =>
    asPermission(parseDialog(screen('permission-bash').replace('\n echo hello > probe-note.txt\n', `\n ${c}\n`)))
  const changed = command('echo bye > probe-note.txt')
  assert.deepEqual(changed.body, ['Write hello into a probe note file', 'echo bye > probe-note.txt'])
  assert.notEqual(changed.fingerprint, bash.fingerprint)
  // Every character counts: what markdown or spacing would hide is another command.
  for (const [a = '', b = ''] of [
    ['cat my_secret.txt', 'cat mysecret.txt'],
    ['rm -rf build_*', 'rm -rf build'],
    ['echo "a  b"', 'echo "a b"'],
    ['echo `id`', 'echo id'],
  ]) {
    assert.notEqual(command(a).fingerprint, command(b).fingerprint, `${a} / ${b}`)
    assert.deepEqual(command(a).body.at(-1), a)
  }
  // Where the cursor stands is not part of the prompt.
  const moved = asPermission(
    parseDialog(screen('permission-bash').replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No')),
  )
  assert.equal(moved.cursor, 4)
  assert.equal(moved.fingerprint, bash.fingerprint)
})

const shownPermission = (d: PermissionDialog) => {
  const shown = publicDialog(d)
  assert.equal(shown?.kind, 'permission')
  return shown as Extract<NonNullable<ReturnType<typeof publicDialog>>, { kind: 'permission' }>
}

test('publicDialog cuts long prompts with a mark, never silently', () => {
  const bash = asPermission(parseDialog(screen('permission-bash')))
  assert.deepEqual(Object.keys(must(publicDialog(bash))).sort(), [
    'body',
    'fingerprint',
    'kind',
    'more',
    'options',
    'prompt',
    'title',
  ])
  assert.equal(shownPermission(bash).more, 0)
  const long = { ...bash, body: [...Array.from({ length: 100 }, (_, i) => `line ${i}`), 'x'.repeat(900)] }
  const shown = shownPermission(long)
  assert.equal(shown.body.length, 80)
  assert.equal(shown.more, 21)
  assert.equal(shownPermission({ ...bash, body: ['y'.repeat(900)] }).body[0]?.at(-1), '…')
  assert.equal(shown.fingerprint, bash.fingerprint) // of the whole, from the parse
})

test('a long label wrapped at a space or in the middle of a word is the same label', () => {
  const label = 'Keep the generated files under C:\\work\\projects\\a-rather-long-folder-name\\with\\several\\levels'
  const q = first(
    form({
      questions: [
        {
          question: 'Where should the build put its output?',
          header: 'Out',
          options: [{ label }, { label: 'Elsewhere' }],
        },
      ],
    }),
  )
  const draw = (head: string, rest: string) =>
    [
      '❯ earlier',
      '─'.repeat(40),
      ' ☐ Out',
      '',
      'Where should the build',
      'put its output?',
      '',
      `❯ 1. ${head}`,
      `     ${rest}`,
      '  2. Elsewhere',
      '  3. Type something.',
      '─'.repeat(40),
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')
  // At a space (the space gone), in the middle of the path (nothing gone).
  assert.ok(
    onQuestion(
      parseDialog(
        draw('Keep the generated files under', 'C:\\work\\projects\\a-rather-long-folder-name\\with\\several\\levels'),
      ),
      q,
    ),
  )
  assert.ok(
    onQuestion(
      parseDialog(
        draw('Keep the generated files under C:\\work\\projects\\a-rather-lon', 'g-folder-name\\with\\several\\levels'),
      ),
      q,
    ),
  )
  assert.ok(!onQuestion(parseDialog(draw('Keep the generated files under C:\\work\\other', 'folder')), q))
})

test('a question taller than its pane is read cut, and as that question while all of its question shows', () => {
  const q = first(PHOTOS)
  // 112 cells wide: the rule and the tab bar are off the screen, the question shows whole.
  const wide = asQuestion(parseDialog(screen('question-cut-wide')))
  assert.equal(wide.cut, true)
  assert.equal(wide.question, q.question)
  assert.equal(wide.cursor, 1)
  // 60 wide: the tab bar is the top line, its rule is off the screen.
  const narrow = asQuestion(parseDialog(screen('question-cut-narrow')))
  assert.deepEqual(narrow.tabs, [{ header: 'Photos', answered: false }])
  // An own answer typed in: the footer that says so wraps over two lines, the tab bar goes off.
  const typed = asQuestion(parseDialog(screen('question-cut-typed')))
  assert.equal(typed.cursor, 4)
  assert.equal(typed.editing, true)
  assert.equal(typedOther(typed), 'Keep them where they are for now')
  for (const d of [wide, narrow, typed]) {
    assert.ok(onQuestion(d, q))
    assert.equal(screenIndex(d, PHOTOS), 0)
    assert.ok(!tooTall(d, q))
    assert.equal(publicDialog(d)?.kind, 'question')
  }
  // Another question over the same options, or other options under the same question.
  assert.ok(!onQuestion(wide, { ...q, question: 'How do we keep a copy of the old pictures?' }))
  assert.ok(!onQuestion(wide, { ...q, options: q.options.slice(0, 2) }))
  assert.ok(
    !onQuestion(wide, { ...q, options: q.options.map((o, j) => (j === 1 ? { ...o, label: 'Delete all' } : o)) }),
  )
})

test('a dialog cut into its question or its options is never taken for it, and tooTall says why', () => {
  const q = first(PHOTOS)
  // 50 wide: the end of the question shows.
  const deep = asQuestion(parseDialog(screen('question-cut-deep')))
  assert.equal(
    deep.question,
    'library is not mounted on this machine and the sync tool hands out one picture at a time. How do we keep a copy?',
  )
  // Shorter: option 1, and the cursor on it, are off the screen too.
  const options = asQuestion(parseDialog(screen('question-cut-options')))
  assert.equal(options.question, '')
  assert.deepEqual(
    options.options.map(o => [o.n, o.label, !!o.hidden]),
    [
      [1, '', true],
      [2, 'Delete them, keep a list', false],
      [3, 'A one-off export job for the zip', false],
      [4, 'Type something.', false],
    ],
  )
  assert.equal(options.cursor, null)
  for (const d of [deep, options]) {
    assert.ok(!onQuestion(d, q))
    assert.equal(screenIndex(d, PHOTOS), -1)
    assert.ok(tooTall(d, q))
  }
  // tooTall of another question: what shows of the question or of the options is not its own.
  assert.ok(!tooTall(deep, { ...q, question: 'Which pictures go to the archive folder this spring?' }))
  assert.ok(
    !tooTall(options, { ...q, options: q.options.map((o, j) => (j === 1 ? { ...o, label: 'Delete all' } : o)) }),
  )
  assert.ok(!tooTall(options, { ...q, options: q.options.slice(0, 2) }))
  assert.ok(!tooTall(options, { ...q, preview: true }))
  // A dialog that shows whole is never too tall.
  assert.ok(!tooTall(parseDialog(screen('question-single')), first(COLOR)))
  assert.ok(!tooTall(parseDialog(screen('question-single')), q))
})

test('only the bottom of a question dialog is read cut', () => {
  const cut = screen('question-cut-options')
  for (const other of [
    `${cut}\n  ⏵⏵ auto mode on`, // something under the footer
    cut.replace(/\n {2}5\. Chat about this/, ''), // no "Chat about this"
    cut.replace('Enter to select', 'Press Enter'), // another footer
    cut.replace('     later with a separate OK', 'later with a separate OK'), // above option 2, not the end of option 1
  ])
    assert.equal(parseDialog(other), null, other.slice(0, 80))
  // Above option 1 only the question and its tab bar: an indented line there is something else.
  const wide = screen('question-cut-wide')
  assert.ok(wide.includes('│ and the sync tool'))
  assert.equal(parseDialog(wide.replace('│ and the sync tool', '     and the sync tool')), null)
  // A dialog with previews is not read cut.
  const preview = screen('question-preview').split('\n')
  assert.equal(parseDialog(preview.slice(preview.findIndex(l => /1\. Sidebar/.test(l))).join('\n')), null)
  // Every screen that showed a whole dialog reads as before.
  for (const name of [
    'question-single',
    'question-single-bar',
    'question-tabs-1',
    'question-tabs-2-multi',
    'question-tabs-3',
    'question-tabs-3-other',
    'question-tabs-3-typed',
    'question-lone-multi',
    'question-preview',
  ])
    assert.equal(asQuestion(parseDialog(screen(name))).cut, false, name)
})

test('a review that draws a long question with a bar before each of its lines (Claude Code 2.1.322)', () => {
  const d = asReview(parseDialog(screen('question-review-bar')))
  assert.deepEqual(d.answers, [
    { question: must(CLUB[0]).question, answer: 'Yes, send a test message (Recommended)' },
    { question: must(CLUB[1]).question, answer: 'Switch it on now (Recommended)' },
  ])
  const yes = { choose: [1], other: '' }
  assert.ok(reviewMatches(d, CLUB, [yes, yes]))
  assert.ok(!reviewMatches(d, CLUB, [{ choose: [2], other: '' }, yes]))
  // The bar goes only before the dot: one after it is the question's own.
  const own = asReview(parseDialog(screen('question-review-bar').replace(' │ ● The reminder', ' ● │ The reminder')))
  assert.ok(own.answers[0]?.question.startsWith('│ The reminder'))
})

test('parseDialog finds nothing on a plain screen or another dialog', () => {
  assert.equal(parseDialog(''), null)
  assert.equal(parseDialog('❯ \n──────────\n  ⏵⏵ bypass permissions on'), null)
  const trust = [
    '─'.repeat(40),
    ' Accessing workspace:',
    '',
    ' Quick safety check: Is this a project you trust?',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  assert.equal(parseDialog(trust), null)
})

test('small helpers', () => {
  assert.deepEqual(arrows(1, 3), ['down', 'down'])
  assert.deepEqual(arrows(4, 2), ['up', 'up'])
  assert.deepEqual(arrows(2, 2), [])
  assert.ok(sameText('Tomorrow  at noon', 'Tomorrow at noon'))
  assert.ok(
    sameText(
      'A very long own answer that the terminal cut sh…',
      'A very long own answer that the terminal cut short at the edge',
    ),
  )
  assert.ok(!sameText('Short…', 'Shorter text entirely'))
})

// ---------------------------------------------------------------- driving the dialog

test('a lone single select: one digit, nothing else', async () => {
  for (const lag of [0, 2]) {
    const fake = new FakeDialog(COLOR, { lag })
    const r = await driveQuestions({
      questions: COLOR,
      picks: picksOf(COLOR, [{ options: ['Blue'] }]),
      io: fake.io(),
      timing: fast,
    })
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(fake.keysLog, ['3'])
    assert.deepEqual(fake.submitted, ['Blue'])
  }
})

test('a question drawn with a bar is answered as before: an option, or an own answer', async () => {
  const option = new FakeDialog(COLOR, { bar: true, lag: 1 })
  const r = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Green'] }]),
    io: option.io(),
    timing: fast,
  })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(option.submitted, ['Green'])
  const own = new FakeDialog(COLOR, { bar: true, lag: 1 })
  const typed = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ other: 'cancel that, no remote for now' }]),
    io: own.io(),
    timing: fast,
  })
  assert.deepEqual(typed, { ok: true })
  assert.deepEqual(own.submitted, ['cancel that, no remote for now'])
})

test('option 1 with a slow redraw is pressed once, never followed by Enter', async () => {
  const fake = new FakeDialog(COLOR, { lag: 3 })
  const r = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Red'] }]),
    io: fake.io(),
    timing: fast,
  })
  assert.ok(r.ok)
  assert.deepEqual(fake.keysLog, ['1'])
})

test('an own answer is reached with arrows, cleared and typed, never by its digit', async () => {
  const fake = new FakeDialog(COLOR, { lag: 1 })
  must(fake.state[0]).other = 'left from before' // a digit here would submit this text at once
  const r = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ other: 'Teal' }]),
    io: fake.io(),
    timing: fast,
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.keysLog, ['down', 'down', 'down', 'ctrl+u', 'enter'])
  assert.deepEqual(fake.texts, ['Teal'])
  assert.deepEqual(fake.submitted, ['Teal'])
})

test('an own answer with a leading dash: the space herdr gets before it is taken out again', async () => {
  const cases: [FormQuestion[], unknown, string[]][] = [
    [COLOR, [{ other: '-1 day' }], ['-1 day']],
    [PLATFORMS, [{ options: ['Linux'], other: '-arm64' }], ['Linux, -arm64']],
  ]
  for (const [questions, answers, want] of cases) {
    const fake = new FakeDialog(questions, { lag: 1 })
    const io = fake.io()
    const text = io.text
    io.text = (t: string) => text(/^-/.test(t) ? ` ${t}` : t) // as paneIO sends it
    const r = await driveQuestions({ questions, picks: picksOf(questions, answers), io, timing: fast })
    assert.ok(r.ok, JSON.stringify(r))
    assert.deepEqual(fake.submitted, want)
    assert.ok(fake.keysLog.join(' ').includes('ctrl+a right backspace'))
  }
  // Without a dash nothing is moved.
  const fake = new FakeDialog(COLOR)
  await driveQuestions({ questions: COLOR, picks: picksOf(COLOR, [{ other: 'Teal' }]), io: fake.io(), timing: fast })
  assert.ok(!fake.keysLog.includes('ctrl+a'))
})

test('three questions: single, multiSelect, own answer, then the review and submit', async () => {
  const fake = new FakeDialog(ORDER, { lag: 1 })
  const picks = picksOf(ORDER, [
    { options: ['Large'] },
    { options: ['Cheese', 'Basil'] },
    { other: 'Tomorrow at noon' },
  ])
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.submitted, ['Large', 'Cheese, Basil', 'Tomorrow at noon'])
  assert.equal(fake.keysLog.at(-1), '1')
})

test('a lone multiSelect with an own answer goes through its Submit row and the review', async () => {
  const fake = new FakeDialog(PLATFORMS)
  const picks = picksOf(PLATFORMS, [{ options: ['macOS'], other: 'FreeBSD' }])
  const r = await driveQuestions({ questions: PLATFORMS, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.submitted, ['macOS, FreeBSD'])
})

test('options with previews: the digit moves the cursor, Enter picks', async () => {
  const fake = new FakeDialog(LAYOUT)
  const r = await driveQuestions({
    questions: LAYOUT,
    picks: picksOf(LAYOUT, [{ options: ['Tabs'] }]),
    io: fake.io(),
    timing: fast,
  })
  assert.ok(r.ok)
  assert.deepEqual(fake.keysLog, ['2', 'enter'])
  assert.deepEqual(fake.submitted, ['Tabs'])
})

test('begun in the terminal: back to the first question, ticks set to what was picked', async () => {
  const fake = new FakeDialog(ORDER)
  must(fake.state[0]).answer = 'Small'
  must(fake.state[1]).checked = new Set([2, 3])
  fake.tab = 2
  must(fake.state[2]).cursor = 3 // in the own answer's field
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese', 'Basil'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.keysLog.slice(0, 3), ['up', 'left', 'left'])
  assert.deepEqual(fake.submitted, ['Large', 'Cheese, Basil', 'Now'])
})

test('another question on the screen: nothing is pressed', async () => {
  const fake = new FakeDialog(ORDER)
  const r = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Red'] }]),
    io: fake.io(),
    timing: fast,
  })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'changed')
  assert.deepEqual(fake.keysLog, [])
})

test('a dialog taller than its pane is answered while all of its question shows', async () => {
  // 13 lines: the rule and the tab bar are off the screen, the question is the top line.
  for (const lag of [0, 2]) {
    const option = new FakeDialog(COLOR, { height: 13, lag })
    assert.equal(asQuestion(parseDialog(option.render())).cut, true)
    const r = await driveQuestions({
      questions: COLOR,
      picks: picksOf(COLOR, [{ options: ['Blue'] }]),
      io: option.io(),
      timing: fast,
    })
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(option.keysLog, ['3'])
    assert.deepEqual(option.submitted, ['Blue'])
    const own = new FakeDialog(COLOR, { height: 13, lag })
    const typed = await driveQuestions({
      questions: COLOR,
      picks: picksOf(COLOR, [{ other: 'Teal' }]),
      io: own.io(),
      timing: fast,
    })
    assert.deepEqual(typed, { ok: true })
    assert.deepEqual(own.keysLog, ['down', 'down', 'down', 'ctrl+u', 'enter'])
    assert.deepEqual(own.submitted, ['Teal'])
  }
  // A multiSelect with an own answer, then its review.
  const multi = new FakeDialog(PLATFORMS, { height: 14 })
  assert.equal(asQuestion(parseDialog(multi.render())).cut, true)
  const ticked = await driveQuestions({
    questions: PLATFORMS,
    picks: picksOf(PLATFORMS, [{ options: ['Linux'], other: 'FreeBSD' }]),
    io: multi.io(),
    timing: fast,
  })
  assert.ok(ticked.ok, JSON.stringify(ticked))
  assert.deepEqual(multi.submitted, ['Linux, FreeBSD'])
  // A set whose tallest question loses its rule: its tab bar is the top line.
  const set = new FakeDialog(ORDER, { height: 16, lag: 1 })
  const picks = picksOf(ORDER, [
    { options: ['Large'] },
    { options: ['Cheese', 'Basil'] },
    { other: 'Tomorrow at noon' },
  ])
  const all = await driveQuestions({ questions: ORDER, picks, io: set.io(), timing: fast })
  assert.ok(all.ok, JSON.stringify(all))
  assert.deepEqual(set.submitted, ['Large', 'Cheese, Basil', 'Tomorrow at noon'])
})

test('a dialog cut into its question: nothing is pressed, and the user is told the pane is too short', async () => {
  const drive = (fake: FakeDialog, questions: FormQuestion[], answers: unknown) =>
    driveQuestions({ questions, picks: picksOf(questions, answers), io: fake.io(), timing: fast })
  // Option 1 above the edge (10 lines), or only the own-answer row on the screen (5 lines).
  for (const height of [10, 5]) {
    const fake = new FakeDialog(TALL, { height })
    const r = await drive(fake, TALL, [{ options: ['Delete them'] }])
    assert.ok(!r.ok)
    assert.equal(r.reason, 'cut')
    assert.deepEqual(r.step, { what: 'start' })
    assert.deepEqual(fake.keysLog, [])
  }
  // Another question with the same options, its text off the screen: the board cannot tell, so
  // it presses nothing.
  const other = form({ questions: [{ ...must(TALL[0]), question: 'Which plan for the new pictures?' }] })
  const same = new FakeDialog(other, { height: 10 })
  const r = await drive(same, TALL, [{ options: ['Delete them'] }])
  assert.ok(!r.ok)
  assert.deepEqual(same.keysLog, [])
  // That question with all of it on the screen is another one, as ever.
  const shown = new FakeDialog(other, { height: 13 })
  const changed = await drive(shown, TALL, [{ options: ['Delete them'] }])
  assert.ok(!changed.ok)
  assert.equal(changed.reason, 'changed')
  assert.deepEqual(shown.keysLog, [])
  // A multiSelect cut into its question.
  const multi = new FakeDialog(PLATFORMS, { height: 11 })
  const ticks = await drive(multi, PLATFORMS, [{ options: ['Linux'] }])
  assert.ok(!ticks.ok)
  assert.equal(ticks.reason, 'cut')
  assert.deepEqual(multi.keysLog, [])
  // A set whose second question is taller than the pane: stopped there, after the first answer.
  const set = new FakeDialog(ORDER, { height: 13 })
  const midway = await drive(set, ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }])
  assert.ok(!midway.ok)
  assert.equal(midway.reason, 'cut')
  assert.deepEqual(midway.step, { q: 2, what: 'question' })
  assert.deepEqual(set.keysLog, ['2'])
})

test('a screen read while Claude Code redraws: the board looks again before it refuses', async () => {
  const fake = new FakeDialog(COLOR)
  const io = fake.io()
  const read = io.read
  let reads = 0
  // The first read catches the dialog half drawn: its question, none of its options yet.
  io.read = async () => {
    const shown = await read()
    return ++reads === 1 ? shown.split('\n').slice(0, 9).join('\n') : shown
  }
  const r = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Blue'] }]),
    io,
    timing: fast,
  })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(fake.keysLog, ['3'])
})

test('a set whose review draws long questions with a bar is submitted', async () => {
  const fake = new FakeDialog(ORDER, { bar: true, lag: 1 })
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.submitted, ['Large', 'Cheese', 'Now'])
})

test('a terminal that does not respond: it stops after the first key', async () => {
  const fake = new FakeDialog(ORDER, { ignore: true })
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'stuck')
  assert.deepEqual(r.step, { q: 1, what: 'option', n: 2 })
  assert.deepEqual(fake.keysLog, ['2'])
  assert.match(r.screen, /Which size\?/)
})

test('a review that lists other answers is not submitted', async () => {
  const fake = new FakeDialog(ORDER)
  const io = fake.io()
  const read = io.read
  io.read = async () => (await read()).replace('→ Large', '→ Small')
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io, timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'review')
  assert.equal(fake.submitted, null)
  assert.equal(fake.tab, ORDER.length) // left on the review screen
  // "1" ticked Cheese and picked Now; no third one went to "1. Submit answers".
  assert.equal(fake.keysLog.filter(k => k === '1').length, 2)
})

test('a permission prompt is answered only while the screen shows the prompt the user saw', async () => {
  const bash = screen('permission-bash')
  const { fingerprint } = asPermission(parseDialog(bash))
  const keys: string[] = []
  let shown = bash
  const io = {
    read: async () => shown,
    keys: async (...k: string[]) => {
      keys.push(...k)
      shown = IDLE
    },
    text: async () => {},
  }
  assert.deepEqual(await drivePermission({ fingerprint, n: 1, io, timing: fast }), { ok: true })
  assert.deepEqual(keys, ['1'])
  // The next prompt right after: a whole other dialog proves it as well.
  shown = bash
  keys.length = 0
  io.keys = async (...k: string[]) => {
    keys.push(...k)
    shown = screen('permission-write')
  }
  assert.deepEqual(await drivePermission({ fingerprint, n: 1, io, timing: fast }), { ok: true })
  io.keys = async (...k: string[]) => {
    keys.push(...k)
    shown = IDLE
  }
  shown = screen('permission-write')
  keys.length = 0
  const r = await drivePermission({ fingerprint, n: 1, io, timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'changed')
  assert.deepEqual(keys, [])
  shown = bash
  const wrongOption = await drivePermission({ fingerprint, n: 7, io, timing: fast })
  assert.ok(!wrongOption.ok)
  assert.equal(wrongOption.reason, 'changed')
  assert.deepEqual(keys, [])
})

test('done needs proof: a blank or half-drawn screen after the last key is not taken for it', async () => {
  for (const after of ['', '\n\n   \n', '──────────\n Bash command\n']) {
    const fake = new FakeDialog(COLOR)
    const io = fake.io()
    const read = io.read
    io.read = async () => (fake.submitted ? after : read())
    const r = await driveQuestions({
      questions: COLOR,
      picks: picksOf(COLOR, [{ options: ['Blue'] }]),
      io,
      timing: fast,
    })
    assert.ok(!r.ok)
    assert.equal(r.reason, 'unconfirmed', JSON.stringify(after))
    assert.equal(r.sent, 1)
  }
  // The transcript's word is enough, whatever the screen shows meanwhile.
  const slow = new FakeDialog(COLOR, { lag: 50 })
  const ok = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Blue'] }]),
    io: { ...slow.io(), answered: async () => !!slow.submitted },
    timing: fast,
  })
  assert.deepEqual(ok, { ok: true })
  // One frame with the input box between blank ones is not two in a row.
  const bash = screen('permission-bash')
  const { fingerprint } = asPermission(parseDialog(bash))
  let frames: string[] | null = null
  const io = {
    read: async () => (frames ? (frames.shift() ?? '') : bash),
    keys: async () => {
      frames = [IDLE, '', IDLE, '']
    },
    text: async () => {},
  }
  const silent = await drivePermission({ fingerprint, n: 1, io, timing: fast })
  assert.ok(!silent.ok)
  assert.equal(silent.reason, 'unconfirmed')
})

test('the review is submitted only under its own "Submit answers"', async () => {
  const fake = new FakeDialog(ORDER)
  const io = fake.io()
  const read = io.read
  io.read = async () => (await read()).replace('1. Submit answers', '1. Send everything')
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io, timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'review')
  assert.equal(fake.submitted, null)
})

test('herdr failing midway says how much went in', async () => {
  const fake = new FakeDialog(ORDER)
  const io = fake.io()
  const keys = io.keys
  let calls = 0
  io.keys = async (...k: string[]) => {
    if (++calls === 3) throw new Error('pipe closed')
    return keys(...k)
  }
  const picks = picksOf(ORDER, [{ options: ['Large'] }, { options: ['Cheese', 'Basil'] }, { options: ['Now'] }])
  const r = await driveQuestions({ questions: ORDER, picks, io, timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'herdr')
  assert.equal(r.why, 'pipe closed')
  assert.equal(r.sent, 3)
  assert.match(r.screen, /Which toppings\?/)
  const io2 = new FakeDialog(COLOR).io()
  io2.read = async () => {
    throw new Error('no pane')
  }
  const r2 = await driveQuestions({
    questions: COLOR,
    picks: picksOf(COLOR, [{ options: ['Red'] }]),
    io: io2,
    timing: fast,
  })
  assert.ok(!r2.ok)
  assert.equal(r2.reason, 'herdr')
  assert.equal(r2.sent, 0)
})
