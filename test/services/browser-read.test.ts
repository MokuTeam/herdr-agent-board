// The agent's browser read compactly (services/browser-read.ts): read_page's text as the page makes
// it (pageText, run from its own source in a real DOM, jsdom, as evaluate_script runs it), its
// parts, offsets and find; list_interactive from take_snapshot's text, with its uids as they are and
// never a password; and both through chrome-devtools-mcp's calls.
import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  evaluated,
  findIn,
  interactiveReply,
  type PageText,
  pageReply,
  pageScript,
  partEnd,
  readTool,
  shortUrl,
  snapshotNodes,
  steered,
} from '../../src/services/browser-read.ts'

/** pageText run in a page of this HTML, from the source evaluate_script is given. */
function read(html: string, o: { selector?: string | null; links?: boolean; url?: string } = {}): PageText {
  const dom = new JSDOM(html, { url: o.url ?? 'https://example.org/wiki/Karakol', runScripts: 'outside-only' })
  const fn = dom.window.eval(`(${pageScript(o.selector ?? null, o.links ?? true)})`) as () => PageText
  return JSON.parse(JSON.stringify(fn()))
}

const ARTICLE = `<!doctype html><title>Karakol - Wiki</title><body>
<header><a href="/">Logo</a><nav><a href="/a">Home</a> <a href="/b">About</a></nav></header>
<div class="cookie-banner">We use cookies. <button>Accept</button></div>
<main>
  <h1>Karakol</h1>
  <div class="vector-page-toolbar"><a href="/talk">Talk</a> <a href="/edit">Edit</a></div>
  <p>Karakol is a city in <a href="/wiki/Kyrgyzstan">Kyrgyzstan</a>, near <a href="https://en.example.com/Issyk-Kul?x=1">Issyk-Kul</a>.<a href="#cite-1">[1]</a></p>
  <script>var secret = 1</script><style>p{}</style>
  <p hidden>Hidden text</p><p style="display:none">None text</p><span aria-hidden="true">icon</span>
  <h2>History <a href="/edit?s=1">edit</a></h2>
  <ul><li>Founded 1869<ul><li>as a fort</li></ul></li><li>Renamed <b>Przhevalsk</b></li></ul>
  <ol start="3"><li>three</li><li>four</li></ol>
  <table class="wikitable"><caption>Population</caption><tr><th>Year</th><th>People</th></tr><tr><td>1999</td><td>64 | 322</td></tr></table>
  <table><tr><td><p>Layout cell</p></td></tr></table>
  <pre>code  line
second</pre>
  <blockquote>A quote</blockquote>
  <form><label>Name <input name="n" value="alice"></label><input type="password" value="hunter2" aria-label="Password"><input type="checkbox" checked> Keep
  <select><option>One</option><option selected>Two</option></select><input type="submit" value="Go"><input type="hidden" value="tok"></form>
  <div role="navigation" class="navbox"><a href="/x">X</a> <a href="/y">Y</a></div>
  <a href="javascript:void(0)">Script link</a> <a href="/wiki/%D0%9A%D0%B0%D1%80%D0%B0%D0%BA%D0%BE%D0%BB">Каракол</a>
</main>
<aside>Aside text</aside>
<footer>Footer text</footer>
</body>`

test('read_page: the main content as compact text, without navigation, banners, hidden parts, scripts or values', () => {
  const p = read(ARTICLE)
  expect(p.title).toBe('Karakol - Wiki')
  expect(p.url).toBe('https://example.org/wiki/Karakol')
  expect(p.root).toBe('main')
  expect(p.text).toBe(
    [
      '# Karakol',
      '',
      'Karakol is a city in [Kyrgyzstan](/wiki/Kyrgyzstan), near [Issyk-Kul](en.example.com/Issyk-Kul?x=1).[1]',
      '',
      '## History edit',
      '',
      '- Founded 1869',
      '  - as a fort',
      '- Renamed Przhevalsk',
      '3. three',
      '4. four',
      'Population',
      '| Year | People |',
      '| --- | --- |',
      '| 1999 | 64 \\| 322 |',
      'Layout cell',
      '```',
      'code  line',
      'second',
      '```',
      '> A quote',
      'Name [field] [password field: Password] [x] Keep [select: Two] [button: Go]',
      'Script link [Каракол](/wiki/Каракол)',
    ].join('\n'),
  )
  for (const gone of ['Logo', 'Home', 'cookies', 'Talk', 'secret', 'Hidden', 'None text', 'icon', 'Aside', 'Footer'])
    expect([gone, p.text.includes(gone)]).toEqual([gone, false])
  for (const value of ['alice', 'hunter2', 'tok']) expect(p.text).not.toContain(value)
  // in main: the toolbar and the navbox (the header, the cookie notice, the aside and the footer are outside it)
  expect(p.dropped).toBe(2)
})

test('read_page: links false leaves hrefs out; a selector reads all it matches, navigation too; one that matches nothing or is not one says so', () => {
  const plain = read(ARTICLE, { links: false })
  expect(plain.text).toContain('Karakol is a city in Kyrgyzstan, near Issyk-Kul.[1]')
  expect(plain.text).not.toContain('](')
  const nav = read(ARTICLE, { selector: 'nav, footer' })
  expect(nav.root).toBe('nav, footer')
  expect(nav.text).toBe('[Home](/a) [About](/b)\n\n---\n\nFooter text')
  const body = read(ARTICLE, { selector: 'body' })
  expect(body.text).toContain('Footer text')
  expect(body.text).toContain('[Logo](/)')
  expect(body.text).not.toContain('Hidden text')
  expect(read(ARTICLE, { selector: '.nothing' }).error).toContain('Nothing on the page matches .nothing')
  expect(read(ARTICLE, { selector: '[[' }).error).toContain('Not a CSS selector')
})

test('read_page: a link that is only a picture and a control drawn see-through are left out', () => {
  const dom = new JSDOM(
    '<title>P</title><body><main><p>Text <a href="/f.png"><img alt="Flag"></a> <a href="/x"><img alt="">More</a></p>' +
      '<input type="checkbox" id="toggle"> <input type="checkbox" checked></main></body>',
    { url: 'https://example.org/', runScripts: 'outside-only' },
  )
  // jsdom draws nothing: the toggle as Chrome sees one at opacity 0
  const toggle = dom.window.document.getElementById('toggle') as Element & { checkVisibility?: (o?: object) => boolean }
  toggle.checkVisibility = (o?: object) => !(o as { opacityProperty?: boolean } | undefined)?.opacityProperty
  const fn = dom.window.eval(`(${pageScript(null, true)})`) as () => PageText
  expect(fn().text).toBe('Text [More](/x)\n[x]')
})

test('read_page: no main or a small one is the body without its boilerplate; open shadow roots and slots are read', () => {
  const page = read(`<title>Results</title><body><div id="header"><a href="/">DDG</a></div>
    <div class="results"><div class="result"><h2><a href="https://karakol.kg/visit">Visit Karakol</a></h2>
    <a class="result__snippet" href="https://karakol.kg/visit">Karakol is the gateway to the Tian Shan.</a>
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkarakol.kg%2Fr&rut=1">Redirected</a>
    <a href="https://www.karakol.kg/">www.karakol.kg</a></div></div>
    <main><p>tiny</p></main><div class="footer">Footer links</div></body>`)
  expect(page.root).toBe('body')
  expect(page.text).toContain('## Visit Karakol')
  expect(page.text).toContain('[Karakol is the gateway to the Tian Shan.](karakol.kg/visit)')
  expect(page.text).toContain('[Redirected](karakol.kg/r)')
  // a link that reads as its address: once
  expect(page.text).toContain(' www.karakol.kg')
  expect(page.text).not.toContain('](www.karakol.kg)')
  expect(page.text).not.toContain('Footer links')
  const dom = new JSDOM('<title>S</title><body><main><x-card>light <b>slotted</b></x-card></main></body>', {
    url: 'https://example.org/',
    runScripts: 'outside-only',
  })
  const host = dom.window.document.querySelector('x-card') as Element
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<h3>Card title</h3><p>From the shadow <slot></slot></p>'
  const fn = dom.window.eval(`(${pageScript(null, true)})`) as () => PageText
  expect(fn().text).toBe('### Card title\n\nFrom the shadow light slotted')
})

test('read_page: its answer in parts at line ends, with the length and the next offset; find gives the places with offsets', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Line ${i} of the article about Karakol, the city.`)
  lines[250] = 'The population was 84,351 in 2021.'
  const p: PageText = { title: 'Karakol', url: 'https://x.org/k', root: 'main', text: lines.join('\n'), dropped: 4 }
  expect(pageReply({ ...p, url: 'https://ru.x.org/wiki/%D0%9A%D0%B0 b%20c' }, {})).toStartWith(
    'Karakol | https://ru.x.org/wiki/Ка%20b%20c\n',
  )
  const first = pageReply(p, {})
  const [head, ...rest] = first.split('\n\n')
  expect(head).toContain('Karakol | https://x.org/k')
  expect(head).toContain(`its main content, ${p.text.length.toLocaleString('en-US')} characters`)
  expect(head).toContain('4 navigation, menu and footer blocks left out')
  const next = Number(/more: offset=(\d+)/.exec(head ?? '')?.[1])
  expect(next).toBeGreaterThan(5000)
  expect(next).toBeLessThanOrEqual(6000)
  expect(p.text[next - 1]).toBe('\n')
  expect(rest.join('\n\n')).toBe(p.text.slice(0, next).trimEnd())
  const second = pageReply(p, { offset: next, maxChars: 1000 })
  expect(second).toContain(`more: offset=${partEnd(p.text, next, 1000)}`)
  expect(
    second
      .split('\n\n')
      .slice(1)
      .join('\n\n')
      .startsWith(p.text.slice(next, next + 20)),
  ).toBe(true)
  const last = pageReply(p, { offset: p.text.length - 10 })
  expect(last).toContain('the end')
  expect(pageReply(p, { offset: p.text.length + 5 })).toContain('Nothing after offset')
  // small pages whole
  expect(pageReply({ ...p, text: 'short', dropped: 0 }, {})).toContain('All of it.\n\nshort')
  expect(pageReply({ ...p, text: '' }, {})).toContain('No text in it.')
  // find: the line, a line around it, where it is
  const found = pageReply(p, { find: 'POPULATION' })
  const at = p.text.indexOf(lines[249] as string)
  expect(found).toContain('1 line with "POPULATION"')
  expect(found).toContain(`@ offset=${at}\n${lines[249]}\n${lines[250]}\n${lines[251]}`)
  expect(found.length).toBeLessThan(600)
  expect(pageReply(p, { find: 'glacier' })).toContain('"glacier" is not in the text')
  // many matches: cut to maxChars, with where to go on
  const many = findIn(p.text, 'Karakol', { context: 0, offset: 0, max: 500 })
  expect(many).toContain('399 lines with "Karakol"')
  expect(many).toMatch(/more: find again with offset=\d+/)
  expect(many.length).toBeLessThan(800)
})

/** A take_snapshot answer as chrome-devtools-mcp writes it. */
const SNAPSHOT = [
  '## Latest page snapshot',
  'uid=1_0 RootWebArea "Karakol - Wikipedia" url="https://en.wikipedia.org/wiki/Karakol"',
  '  uid=1_2 link "Jump to content" url="https://en.wikipedia.org/wiki/Karakol#bodyContent"',
  '  uid=1_4 banner',
  '    uid=1_5 navigation "Site"',
  '      uid=1_6 button "Main menu" haspopup="menu"',
  '    uid=1_10 search',
  '      uid=1_12 searchbox "Search Wikipedia" description="Search Wikipedia [alt-f]" keyshortcuts="Alt+f"',
  '      uid=1_13 button "Search"',
  '  uid=1_20 main',
  '    uid=1_21 heading "Karakol" level="1"',
  '    uid=1_22 StaticText "Karakol is a city"',
  '    uid=1_23 "in "',
  '    uid=1_24 link "Kyrgyzstan" url="https://en.wikipedia.org/wiki/Kyrgyzstan"',
  '    uid=1_25 link "Каракол" url="https://ru.wikipedia.org/wiki/%D0%9A%D0%B0%D1%80%D0%B0%D0%BA%D0%BE%D0%BB"',
  '    uid=1_26 heading "Sign up" level="2"',
  '    uid=1_27 form',
  '      uid=1_28 textbox "User" value="alice" focusable focused',
  '      uid=1_29 textbox "Secret" value="•••••••"',
  '      uid=1_30 textbox "Password" value="plain-if-ever"',
  '      uid=1_31 checkbox "Keep" checked',
  '      uid=1_32 checkbox "Mixed" checked="mixed"',
  '      uid=1_33 combobox expandable haspopup="menu" value="Two"',
  '        uid=1_34 option "One"',
  '        uid=1_35 option "Two" selectable selected',
  '      uid=1_36 textbox multiline value="notes"',
  '      uid=1_37 button "Say "hi" now" disableable disabled',
  '      uid=1_38 button "Toggle" expandable expanded',
  '    uid=1_39 image "Logo" url="https://x/logo.png"',
  '  uid=1_40 contentinfo',
  '    uid=1_41 link "Privacy" url="https://foundation.wikimedia.org/wiki/Privacy_policy"',
  '    uid=1_42 link "www.karakol.kg" url="https://www.karakol.kg/"',
].join('\n')

test('list_interactive: actionable elements with take_snapshot’s uids, labels and state, under their landmarks and headings; never a password', () => {
  const nodes = snapshotNodes(SNAPSHOT)
  expect(nodes.find(n => n.uid === '1_37')).toEqual({
    depth: 3,
    uid: '1_37',
    role: 'button',
    name: 'Say "hi" now',
    attrs: { disableable: true, disabled: true },
  })
  expect(nodes.find(n => n.uid === '1_23')).toEqual({ depth: 2, uid: '1_23', role: '', name: 'in ', attrs: {} })
  // its text ends with a line break; a name may hold one
  expect(snapshotNodes(`${SNAPSHOT}\n\n`).at(-1)?.name).toBe('www.karakol.kg')
  expect(snapshotNodes('uid=1_0 RootWebArea "T"\n  uid=1_1 StaticText "one\ntwo"\n').at(-1)?.name).toBe('one\ntwo')
  const out = interactiveReply(SNAPSHOT, {})
  expect(out).toBe(
    [
      'Karakol - Wikipedia | https://en.wikipedia.org/wiki/Karakol',
      '17 elements. Each line: uid, role, label, state; click, fill and the others take the uid.',
      '',
      '1_2 link "Jump to content" #bodyContent',
      '[navigation "Site"]',
      '1_6 button "Main menu"',
      '[search]',
      '1_12 searchbox "Search Wikipedia"',
      '1_13 button "Search"',
      '[main]',
      '# Karakol',
      '1_24 link "Kyrgyzstan" /wiki/Kyrgyzstan',
      '1_25 link "Каракол" ru.wikipedia.org/wiki/Каракол',
      '[form]',
      '## Sign up',
      '1_28 textbox "User" value="alice" focused',
      '1_29 textbox "Secret" value=(hidden)',
      '1_30 textbox "Password" value=(hidden)',
      '1_31 checkbox "Keep" checked',
      '1_32 checkbox "Mixed" checked=mixed',
      '1_33 combobox value="Two" options: One | Two',
      '1_36 textbox value="notes" multiline',
      '1_37 button "Say "hi" now" disabled',
      '1_38 button "Toggle" expanded',
      '[contentinfo]',
      '1_41 link "Privacy" foundation.wikimedia.org/wiki/Privacy_policy',
      '1_42 link "www.karakol.kg"',
    ].join('\n'),
  )
  expect(out).not.toContain('plain-if-ever')
  expect(out).not.toContain('•')
})

test('list_interactive: find and links false filter; a long list in parts by element offset', () => {
  const found = interactiveReply(SNAPSHOT, { find: 'search' })
  expect(found).toContain('2 elements with "search"')
  expect(found).toContain('1_12 searchbox "Search Wikipedia"\n1_13 button "Search"')
  expect(found).not.toContain('1_24')
  const fields = interactiveReply(SNAPSHOT, { links: false })
  expect(fields).toContain('12 elements (no links)')
  expect(fields).not.toContain(' link ')
  expect(interactiveReply(SNAPSHOT, { find: 'nothing here' })).toContain('No element with "nothing here"')
  const big = [
    '## Latest page snapshot',
    'uid=1_0 RootWebArea "Big" url="https://x.org/"',
    ...Array.from(
      { length: 900 },
      (_, i) => `  uid=1_${i + 1} link "Item number ${i + 1}" url="https://x.org/i/${i + 1}"`,
    ),
  ].join('\n')
  const first = interactiveReply(big, {})
  const next = Number(/more: offset=(\d+)/.exec(first)?.[1])
  expect(first.length).toBeLessThan(6400)
  expect(next).toBeGreaterThan(100)
  expect(first).toContain(`900 elements; 1-${next} here`)
  const second = interactiveReply(big, { offset: next })
  expect(second).toContain(`${next + 1}-`)
  expect(second.split('\n')[3]).toBe(`1_${next + 1} link "Item number ${next + 1}" /i/${next + 1}`)
  expect(interactiveReply(big, { offset: 5000 })).toContain('Nothing after element')
})

test('short addresses: a path on the same site, host and path elsewhere, letters decoded, long ones cut', () => {
  const page = 'https://en.wikipedia.org/wiki/Karakol'
  expect(shortUrl('https://en.wikipedia.org/wiki/T%C3%BCp', page)).toBe('/wiki/Tüp')
  expect(shortUrl('https://en.wikipedia.org/wiki/Karakol#History', page)).toBe('#History')
  expect(shortUrl('https://example.com/', page)).toBe('example.com')
  expect(shortUrl('https://example.com/a%20b', page)).toBe('example.com/a%20b')
  expect(shortUrl(`https://example.com/${'x'.repeat(200)}`, page)).toHaveLength(80)
  expect(shortUrl('not a url', page)).toBe('not a url')
  // a search engine's redirect: where it goes
  expect(shortUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FKarakol&rut=c6', page)).toBe(
    '/wiki/Karakol',
  )
  expect(shortUrl('https://www.google.com/url?q=https://karakol.kg/a&sa=U', page)).toBe('karakol.kg/a')
  expect(shortUrl('https://example.com/l/?x=1', page)).toBe('example.com/l/?x=1')
})

test('evaluate_script’s answer: the value in its json block', () => {
  expect(evaluated('Script ran on page and returned:\n```json\n{"a":"```"}\n```')).toEqual({ a: '```' })
  expect(
    evaluated('Page navigated.\nScript ran on page and returned:\n```json\n[1]\n```\nPage navigated to x.'),
  ).toEqual([1])
  expect(evaluated('no block')).toBeUndefined()
})

test('the tools through chrome-devtools-mcp: read_page by evaluate_script (not waiting for the DOM), list_interactive by take_snapshot; their failures as they come', async () => {
  const calls: [string, Record<string, unknown>][] = []
  const page: PageText = { title: 'T', url: 'https://x.org/', root: 'main', text: 'Hello Karakol', dropped: 0 }
  const answer = `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(page)}\n\`\`\``
  const r = await readTool('read_page', { selector: ' #content ', links: false }, async (name, args) => {
    calls.push([name, args])
    return { text: answer, isError: false }
  })
  expect(r).toEqual({ text: pageReply(page, {}), isError: false })
  expect(calls[0]?.[0]).toBe('evaluate_script')
  expect(calls[0]?.[1].waitForStableDom).toBe(false)
  expect(String(calls[0]?.[1].function)).toEndWith('({"selector":"#content","links":false})')
  const failed = await readTool('read_page', {}, async () => ({ text: 'A dialog is open', isError: true }))
  expect(failed).toEqual({ text: 'A dialog is open', isError: true })
  const odd = await readTool('read_page', {}, async () => ({ text: 'something else', isError: false }))
  expect(odd.isError).toBe(true)
  const none = await readTool('read_page', { selector: '.x' }, async () => ({
    text: `\`\`\`json\n${JSON.stringify({ ...page, error: 'Nothing on the page matches .x' })}\n\`\`\``,
    isError: false,
  }))
  expect(none).toEqual({ text: 'Nothing on the page matches .x', isError: true })
  const list = await readTool('list_interactive', { find: 'Search' }, async (name, args) => {
    calls.push([name, args])
    return { text: SNAPSHOT, isError: false }
  })
  expect(calls[1]).toEqual(['take_snapshot', {}])
  expect(list.text).toContain('1_13 button "Search"')
})

test('take_snapshot and wait_for point to the compact tools; the other tools as they are', () => {
  const tools = steered([
    { name: 'take_snapshot', description: 'Take a text snapshot.' },
    { name: 'wait_for', description: 'Wait.' },
    { name: 'click', description: 'Clicks.' },
    'odd',
  ]) as { name: string; description: string }[]
  expect(tools[0]?.description).toStartWith('Take a text snapshot. Large:')
  expect(tools[0]?.description).toContain('read_page')
  expect(tools[0]?.description).toContain('list_interactive')
  expect(tools[1]?.description).toContain('read_page')
  expect(tools[2]).toEqual({ name: 'click', description: 'Clicks.' })
  expect(tools[3] as unknown).toBe('odd')
})
