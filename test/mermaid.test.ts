// Mermaid: the locked-down config a directive can't loosen, error lines mapped back to the file, and which flowchart
// nodes are proven to sit on one source line.
import mermaid from 'mermaid'
import { blockLines, contrast, failureOf, familyOf, labelLines, labelsIn, MAX_EDGES, mermaidConfig, nodeLines, pageInkOn, partsOf, SECURE, sourceIdOf, sourceKeyword, sourceLine, typeahead, typedAfter, TYPEAHEAD_MS, typeName, wirePart, type LabelCandidate, type Part, type Tokens } from '../src/renderer/src/lib/mermaid.ts'
import { partOption } from '../src/renderer/src/lib/refCopy.ts'
import { hasFind, hasPreview } from '../src/renderer/src/lib/presentation.ts'
import { equal, ok } from './support/harness.mjs'

const same = (a: unknown, b: unknown, m: string): void => equal(JSON.stringify(a), JSON.stringify(b), m)
const T = Object.fromEntries(['bg', 'content', 'dim', 'faint', 'bg-raised', 'border-strong', 'tool', 'err', 'ft-blue', 'ft-cyan', 'ft-green', 'ft-yellow', 'ft-purple', 'ft-pink', 'ft-red'].map((n, i) => [n, `#0000${i.toString(16).padStart(2, '0')}`])) as Tokens

// A directive or front matter can't turn HTML labels back on, swap the theme or bring its own CSS. The control run with
// mermaid's default secure list shows the same directive would get through.
{
  const evil = '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "theme": "forest", "themeCSS": ".node rect { fill: red }", "fontFamily": "Comic Sans MS", "darkMode": true, "themeVariables": {"primaryColor": "#ff0000"}, "wrap": true}}%%\nflowchart TD\n  A --> B'
  const front = '---\nconfig:\n  htmlLabels: true\n  theme: forest\n  themeCSS: ".x { fill: red }"\n---\nflowchart TD\n  A --> B'
  const effective = async (cfg: Parameters<typeof mermaid.initialize>[0], text: string) => {
    mermaid.initialize(cfg)
    await mermaid.parse(text)
    return mermaid.mermaidAPI.getConfig()
  }
  const cfg = mermaidConfig(T, false, 'Inter')
  for (const [name, text] of [['init directive', evil], ['front matter', front]] as const) {
    const c = await effective(cfg, text)
    ok(c.htmlLabels === false && c.flowchart?.htmlLabels === false, `${name}: HTML labels stay off`)
    equal(c.theme, 'base', `${name}: the theme stays base`)
    equal(c.themeCSS, undefined, `${name}: no theme CSS`)
    equal(c.fontFamily, 'Inter', `${name}: the font stays Clui's`)
    equal(c.darkMode, false, `${name}: dark mode stays Clui's`)
    equal(c.themeVariables?.primaryColor, T.bg, `${name}: theme variables stay Clui's`)
  }
  equal((await effective(cfg, evil)).wrap, true, 'directive: a key outside the secure list still applies')
  const loose = await effective({ ...cfg, secure: undefined }, evil)
  ok(loose.htmlLabels === true && loose.themeCSS === '.node rect { fill: red }', 'control: without Clui\'s list the same directive gets through')
  ok(['htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'darkMode', 'fontFamily', 'fontSize', 'securityLevel', 'maxEdges'].every((k) => SECURE.includes(k)), 'secure: the spec\'s keys and mermaid\'s defaults')
  ok(cfg.securityLevel === 'strict' && cfg.suppressErrorRendering === true && cfg.maxEdges === MAX_EDGES && cfg.flowchart?.useMaxWidth === false, 'config: strict, no error SVG, edge cap, natural width')
}

// Theme variables: structure from tokens, categories from the file-type palette, never the accent
{
  const v = mermaidConfig(T, true, 'x').themeVariables as Record<string, string>
  ok(v.primaryColor === T.bg && v.nodeBorder === T.dim && v.lineColor === T.faint && v.clusterBkg === T['bg-raised'] && v.textColor === T.content, 'theme: outline nodes on the page, lighter edges')
  ok(v.pie1 === T['ft-blue'] && v.pie7 === T['ft-red'] && v.pie8 === T.dim && v.pie12 === T.dim, 'theme: pie 1 to 7 take the palette, the rest grey')
  ok(v.critBorderColor === T.err && v.doneTaskBkgColor === T.tool && v.sequenceNumberColor === T.bg, 'theme: gantt status and sequence numbers')
}

// Parse errors: mermaid counts lines after dropping directives, comments and front matter; Clui reports the file's
{
  equal(sourceLine('flowchart TD\n A-->B\n C', 2), 2, 'line: plain text is unchanged')
  equal(sourceLine('%%{init: {"wrap": true}}%%\nflowchart TD\n %% a comment\n\n B-->C\n E-->>F\n', 4), 6, 'line: a directive, a comment and a blank line come back')
  equal(sourceLine('---\ntitle: x\n---\nflowchart TD\n A-->B\n E-->>F\n', 3), 6, 'line: front matter comes back')
  const msg = "Parse error on line 4:\n...art TD B-->C E-->>F\n--------------------^\nExpecting 'AMP', got 'TAGEND'"
  same(failureOf(new Error(msg), '%%{init: {"wrap": true}}%%\nflowchart TD\n %% a comment\n\n B-->C\n E-->>F\n'), { t: 'parse', line: 6, excerpt: '...art TD B-->C E-->>F', caret: '--------------------^', expecting: "Expecting 'AMP', got 'TAGEND'" }, 'failure: a parse error splits into excerpt, caret and expecting')
  equal(failureOf(Object.assign(new Error('No diagram type detected'), { name: 'UnknownDiagramError' }), '').t, 'type', 'failure: no diagram type')
  equal(failureOf(new Error('Edge limit exceeded. 501 edges found, but the limit is 500.'), '').t, 'edges', 'failure: too many links')
  const other = failureOf(new Error('x'.repeat(500)), '')
  ok(other.t === 'other' && other.message.length === 400, 'failure: anything else, verbatim and cut to 400')
}

// Nodes to lines: only a node whose line is proven
{
  const text = [
    'flowchart TD', //            1
    '  A[Start] --> B(Check)', // 2
    '  B --> C{Done?}', //        3
    '  C -->|yes| D', //          4
    '  D --> E', //               5
    '  E[First] --> F', //        6
    '  E[Second]', //             7  redeclared
    '  %% G[Commented]', //       8
    '  F & H --> I', //           9
    '  subgraph S [Group]', //    10
    '    J["Quoted label"]', //   11
    '  end', //                   12
    '  K[Shown] --x L', //        13
    '  M[Label] --> N', //        14
    '  style A fill:#f00' //      15
  ].join('\n')
  const v = new Map(
    Object.entries({ A: 'Start', B: 'Check', C: 'Done?', D: 'D', E: 'Second', F: 'F', H: 'H', I: 'I', J: 'Quoted label', K: 'Shown', L: 'L', M: 'Other', N: 'N' }).map(([id, t]) => [id, { text: t }])
  )
  const m = nodeLines(text, v)
  const at = (id: string): number | undefined => (m.has(id) ? m.get(id)! + 1 : undefined)
  equal(at('A'), 2, 'nodes: a node declared on one line maps to it, though a style line mentions it')
  equal(at('B'), 2, 'nodes: declared once, mentioned elsewhere')
  equal(at('C'), 3, 'nodes: a rhombus')
  equal(at('D'), undefined, 'nodes: mentioned on two lines with no declaration stays the diagram\'s')
  equal(at('E'), undefined, 'nodes: declared on two lines stays the diagram\'s')
  equal(at('H'), 9, 'nodes: one mention in an & chain')
  equal(at('J'), 11, 'nodes: a quoted label inside a subgraph')
  equal(at('L'), 13, 'nodes: an x arrowhead is not part of the next id')
  equal(at('M'), undefined, 'nodes: a label that differs from the parsed one stays the diagram\'s')
  ok(!m.has('G'), 'nodes: a commented-out declaration is nothing')
  equal(nodeLines('---\ntitle: T\n---\nflowchart TD\n  T[Title]', new Map([['T', { text: 'Title' }]])).get('T'), 4, 'nodes: front matter lines are not source')
  equal(sourceIdOf('mmd-3-flowchart-my-node-12', 'mmd-3'), 'my-node', 'ids: the source id may hold dashes')
  equal(sourceIdOf('mmd-3-flowchart-A-0', 'mmd-31'), null, 'ids: another render\'s node is not this one\'s')
}

// Kinds
{
  ok(hasPreview('/w/a.mmd') && hasPreview('/w/b.MERMAID'), 'kinds: .mmd and .mermaid have a Preview')
  ok(!hasFind(null, { kind: 'file', key: '/w/a.mmd', mode: 'preview' }) && hasFind(null, { kind: 'file', key: '/w/a.mmd', mode: 'source' }), 'kinds: Find only in a Mermaid file\'s Source')
  ok(typeName('flowchart-v2') === 'Flowchart' && typeName('er') === 'Entity relationship diagram' && typeName('quadrantChart') === 'Diagram', 'kinds: names from the diagram type')
}

// An author's fill with no text colour: the label takes whichever ink reads on it
{
  equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21, 'contrast: black on white is 21')
  ok(pageInkOn('#ffe9a8', '#e6e6e6', '#161617'), 'ink: light text on a light author fill takes the dark page ink')
  ok(!pageInkOn('#ffe9a8', '#1a1a1a', '#ffffff'), 'ink: dark text that reads on the fill keeps the theme\'s ink')
  ok(!pageInkOn('#333333', '#e6e6e6', '#161617'), 'ink: a dark author fill keeps the dark theme\'s light ink')
}

// Parts, from mermaid's own parse of each fixture. Parsing outside a browser needs DOMPurify's two calls and the
// `window.CSS` a sequence `box` colour test reads; neither changes the db.
{
  const purify = (await import('dompurify')).default as unknown as Record<string, unknown>
  const saved = { sanitize: purify.sanitize, addHook: purify.addHook, window: (globalThis as Record<string, unknown>).window }
  Object.assign(purify, { sanitize: (s: string) => s, addHook: () => {} })
  ;(globalThis as Record<string, unknown>).window = { CSS: { supports: () => true } }
  mermaid.initialize(mermaidConfig(T, true, 'x'))
  const dbOf = async (text: string): Promise<unknown> => (await mermaid.mermaidAPI.getDiagramFromText(text)).db
  const table = async (text: string): Promise<Part[]> => {
    const d = await mermaid.mermaidAPI.getDiagramFromText(text)
    const fam = familyOf(d.type)!
    const db = d.db as { getVertices?: () => Map<string, { text?: string }> }
    return partsOf(fam, db, text, fam === 'flowchart' ? nodeLines(text, db.getVertices!()) : undefined)!
  }
  const brief = (ps: Part[]): string[] => ps.map((p) => [p.key, p.from && `${p.from}>${p.to}#${p.nth}`, p.label, p.line, p.lines && `${p.lines.start}-${p.lines.end}`].filter((x) => x !== undefined && x !== '').join(' '))
  const long = 'x'.repeat(100)

  const flow = `flowchart TD\n  subgraph g1 [Group one]\n    A[Start] -->|yes| B(Do it)\n  end\n  x_y --> z\n  A --> B\n  A --> B\n  C[first]\n  C[again]\n  L[${long}]`
  const f = await table(flow)
  same(brief(f), ['g:g1 Group one 1', 'n:A Start 2', 'n:B Do it 2', 'n:x_y 4', 'n:z 4', 'n:C again', `n:L ${'x'.repeat(79)}… 9`, 'e:L_A_B_0 A>B#0 yes', 'e:L_x_y_z_0 x_y>z#0', 'e:L_A_B_2 A>B#1', 'e:L_A_B_3 A>B#2'], 'parts: flowchart groups and nodes in db order, then links')
  ok(f.find((p) => p.key === 'e:L_x_y_z_0')?.from === 'x_y', 'parts: L_x_y_z_0 resolves to x_y → z through the db, not the string')
  same(['e:L_A_B_0', 'e:L_x_y_z_0'].map((k) => wirePart(f.find((p) => p.key === k)!, 1)), [{ kind: 'edge', from: 'A', to: 'B', nth: 0, label: 'yes', fromLabel: 'Start', toLabel: 'Do it' }, { kind: 'edge', from: 'x_y', to: 'z', nth: 0 }], 'parts: a link carries its ends\' drawn text, and none for ends that draw their id')
  equal(f.find((p) => p.key === 'n:C')?.line, undefined, 'parts: a node declared twice has no line')
  same(brief(await table(flow)), brief(f), 'parts: a second parse gives the same keys')
  equal(f.find((p) => p.key === 'n:L')?.label?.length, 80, 'parts: a label clips to 80 with an ellipsis')
  equal((await table('flowchart TD\n  subgraph s\n  a\n  end\n  subgraph s\n  b\n  end')).find((p) => p.key === 'g:s')?.line, undefined, 'parts: a subgraph opened twice has no line')

  const cls = 'classDiagram\n  namespace Zoo {\n    class Animal\n    class Duck\n  }\n  Animal <|-- Duck : is\n  Animal <|-- Duck\n  class Fish\n  class Fish'
  same(brief(await table(cls)), ['g:Zoo 1', 'n:Animal 2', 'n:Duck 3', 'n:Fish', 'e:id_Animal_Duck_1 Animal>Duck#0 is', 'e:id_Animal_Duck_2 Animal>Duck#1'], 'parts: class namespaces, classes and relations, with their declaring lines')

  const state = 'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  state Comp {\n    a --> b\n  }\n  Moving --> [*]\n  state "Long name" as L'
  const st = await table(state)
  same(brief(st), ['n:Still', 'n:Moving', 'g:Comp 3', 'n:a', 'n:b', 'n:L Long name 7', 'e:edge0 [*]>Still#0', 'e:edge1 Still>Moving#0', 'e:edge2 a>b#0', 'e:edge3 Moving>[*]#0'], 'parts: state [*] is no part, but its transitions are, from and to [*]')

  const er = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains\n  CUSTOMER {\n    string name\n  }'
  same(brief(await table(er)), ['n:CUSTOMER 3', 'n:ORDER', 'n:LINE', 'e:id_entity-CUSTOMER-0_entity-ORDER-1_0 CUSTOMER>ORDER#0 places', 'e:id_entity-ORDER-1_entity-LINE-2_1 ORDER>LINE#0 contains'], 'parts: ER entities by name through getEntities, relationships between them')

  const blocks = [
    'sequenceDiagram',
    '  participant Alice',
    '  actor Bob as Robert',
    '  Alice->>Bob: Hello',
    '  loop Every min',
    '    Bob->>Alice: Hi',
    '    loop Inner',
    '      Alice->>Bob: Hello',
    '    end',
    '  end',
    '  %% a comment between blocks',
    '  alt ok',
    '    Alice->>Bob: a',
    '  else fail',
    '    Alice->>Bob: b',
    '  end',
    '  opt maybe',
    '    Note right of Bob: a note',
    '  end',
    '  par one',
    '    Alice->>Bob: c',
    '  and two',
    '    Bob->>Alice: d',
    '  end',
    '  par_over over',
    '    Alice->>Bob: e',
    '  end',
    '  critical crit',
    '    Alice->>Bob: f',
    '  option opt1',
    '    Alice->>Bob: g',
    '  end',
    '  break stop',
    '    Alice->>Bob: h',
    '  end',
    '  rect rgb(0, 0, 0)',
    '    Alice->>Bob: i',
    '  end',
    '  box Aqua Group',
    '  end',
    '  Note over Alice: a note'
  ].join('\n')
  const db = (await dbOf(blocks)) as { LINETYPE: Record<string, number>; getMessages: () => { id: string; type: number }[] }
  same(
    db.LINETYPE,
    { ...db.LINETYPE, LOOP_START: 10, LOOP_END: 11, ALT_START: 12, ALT_ELSE: 13, ALT_END: 14, OPT_START: 15, OPT_END: 16, PAR_START: 19, PAR_AND: 20, PAR_END: 21, RECT_START: 22, RECT_END: 23, CRITICAL_START: 27, CRITICAL_OPTION: 28, CRITICAL_END: 29, BREAK_START: 30, BREAK_END: 31, PAR_OVER_START: 32 },
    'sequence: LINETYPE numbers on this mermaid'
  )
  const types = db.getMessages().map((m) => m.type)
  ok(types.includes(22) && types.includes(23) && types.filter((t) => t === 21).length === 2, 'sequence: rect emits 22/23, par_over closes with 21')
  const sq = await table(blocks)
  same(
    brief(sq),
    [
      'p:Alice 1',
      'p:Bob Robert 2',
      'm:0 Alice>Bob#0 Hello',
      'b:6 Every min 4-9',
      'm:2 Bob>Alice#0 Hi',
      'b:5 Inner 6-8',
      'm:4 Alice>Bob#1 Hello',
      'b:11 ok 11-15',
      'm:8 Alice>Bob#2 a',
      'm:10 Alice>Bob#3 b',
      'b:14 maybe 16-18',
      't:13 a note',
      'b:19 one 19-23',
      'm:16 Alice>Bob#4 c',
      'm:18 Bob>Alice#1 d',
      'b:22 over 24-26',
      'm:21 Alice>Bob#5 e',
      'b:27 crit 27-31',
      'm:24 Alice>Bob#6 f',
      'm:26 Alice>Bob#7 g',
      'b:30 stop 32-34',
      'm:29 Alice>Bob#8 h',
      'm:32 Alice>Bob#9 i',
      't:34 a note'
    ],
    'sequence: participants, then messages, notes and blocks by their start; a block is keyed by its END; rect and box are no parts'
  )
  const kw = (key: string): Part | undefined => sq.find((p) => p.key === key)
  same([kw('m:0')?.fromLabel, kw('m:0')?.toLabel], [undefined, 'Robert'], 'sequence: a message carries the drawn name of an aliased end only')
  same(['b:6', 'b:5', 'b:11', 'b:14', 'b:19', 'b:22', 'b:27', 'b:30'].map((k) => kw(k)?.keyword), ['loop', 'loop', 'alt', 'opt', 'par', 'par', 'critical', 'break'], 'sequence: keywords from the START type, par_over as par')
  same([kw('b:11')?.sections, kw('b:19')?.sections, kw('b:27')?.sections], [['fail'], ['two'], ['opt1']], 'sequence: else, and, option texts are sections')
  same([kw('t:13')?.nth, kw('t:34')?.nth], [0, 1], 'sequence: a note counts earlier notes with its label')
  ok(kw('b:5')!.lines!.start > kw('b:6')!.lines!.start && kw('b:5')!.lines!.end < kw('b:6')!.lines!.end, 'sequence: the nested loop pairs inside the outer one')
  equal(partOption('sequenceDiagram', wirePart(kw('b:11')!, 1)), 'Alt ok, else fail, lines 12 to 16', 'sequence: an alt option names its sections and lines')

  // One miscount would shift every later block, so a source that doesn't line up gives no block lines at all.
  const broken = blocks.replace('    end\n  end\n  %%', '    end %% inner\n  end\n  %%')
  const bk = await table(broken)
  ok(bk.some((p) => p.kind === 'block') && bk.every((p) => p.kind !== 'block' || !p.lines), 'block lines: an end the lexer can\'t read drops every block\'s lines')
  const msgs = db.getMessages()
  const lines = blocks.split('\n')
  ok(blockLines(lines, msgs) instanceof Map, 'block lines: the fixture proves')
  equal(blockLines([...lines, '  end'], msgs), null, 'block lines: an unbalanced extra end proves nothing')
  equal(blockLines(lines.map((l) => l.replace('loop Inner', 'loop Other')), msgs), null, 'block lines: an opener whose text differs proves nothing')
  equal(blockLines(lines.map((l, i) => (i === 8 ? '    %% end' : l)), msgs), null, 'block lines: a commented-out end is skipped, so the count is off')
  const unbalanced = partsOf('sequence', { getActors: () => new Map(), getMessages: () => [{ id: '0', type: 10, message: 'x' }, { id: '1', type: 0, from: 'A', to: 'B', message: 'm' }] }, 'sequenceDiagram')!
  ok(unbalanced.length === 1 && unbalanced[0].kind === 'message', 'blocks: a stack that does not balance yields no blocks')

  equal(sourceKeyword('---\ntitle: x\n---\n%%{init: {"theme": "dark"}}%%\n%% hello\n  stateDiagram-v2\n  a --> b'), 'stateDiagram-v2', 'type: the first word after front matter, directives and comments')
  equal(sourceKeyword('graph LR\n A-->B'), 'graph', 'type: graph as written')

  // The reparse adds to each draw; mermaid's own render is measured by the probe.
  const t0 = performance.now()
  for (let i = 0; i < 5; i++) await table(blocks)
  ok((performance.now() - t0) / 5 < 50, 'draw: the sequence reparse and table stay well under 50 ms')

  Object.assign(purify, { sanitize: saved.sanitize, addHook: saved.addHook })
  ;(globalThis as Record<string, unknown>).window = saved.window
  if (saved.window === undefined) delete (globalThis as Record<string, unknown>).window
}

// Labels inside an area: what the drawing shows, never the source
{
  const c = (text: string, x: number, y: number, w = 40, h = 14, shown = true): LabelCandidate => ({ text, x, y, w, h, shown })
  const area = { x: 0, y: 0, w: 200, h: 100 }
  same(
    labelsIn([c('Code', 60, 10), c('Design', 10, 11), c('Release', 10, 40), c(' ', 10, 60), c('hidden', 10, 70, 40, 14, false), c('zero', 10, 80, 0, 0), c('out', 190, 10), c('edge', 161, 87)], area),
    ['Design', 'Code', 'Release', 'edge'],
    'labels: hidden, zero-size and empty skip; 2px of tolerance; rows by 4px, then left'
  )
  same(labelsIn([c('Alpha', 10, 10), c('Alpha', 11, 11), c('Alpha', 10, 50)], area), ['Alpha', 'Alpha'], 'labels: a double draw counts once, the same text at two places stays two')
  same(labelsIn([c('wrapped\n   two', 10, 10)], area), ['wrapped two'], 'labels: wrapped lines join with one space')
  const gantt = 'gantt\n  title Plan\n  %% Design is commented\n  section Build\n  Design :a1, 2024-01-02, 3d\n  Code :after a1, 2d\n  Me : 1d\n  Me again : 1d\n  Alphabet soup : 1d'
  same(labelLines(gantt, ['Design', '2024-01-01', '40%', 'Me', 'Alpha']), [{ text: 'Design', line: 4 }, { text: '2024-01-01' }, { text: '40%' }, { text: 'Me' }, { text: 'Alpha' }], 'label lines: one line holding it whole gets that line; generated, repeated or partial text none')
  same(labelLines('pie\n  "Dogs" : 40', ['40%', 'Dogs']), [{ text: '40%' }, { text: 'Dogs', line: 1 }], 'label lines: a percentage pie draws is not in the source')
  equal(labelLines('gantt', ['y'.repeat(130)])[0].text.length, 120, 'label lines: a label clips to 120')
}

// The parts listbox type-ahead: a first letter moves past the current option, a longer string keeps it while it matches.
{
  const opts = [{ key: 'n:A', label: 'Start' }, { key: 'n:B', label: 'Do it' }, { key: 'n:C', label: 'Done' }, { key: 'n:x', id: 'xray' }] as Part[]
  equal(typeahead(opts, 0, 'd'), 1, 'typeahead: a first letter searches after the current option')
  equal(typeahead(opts, 1, 'do'), 1, 'typeahead: the extended string stays on the option it still matches')
  equal(typeahead(opts, 1, 'don'), 2, 'typeahead: and moves on once it stops matching')
  equal(typeahead(opts, 1, 'd'), 2, 'typeahead: the same letter again cycles')
  equal(typeahead(opts, 2, 'd'), 1, 'typeahead: wrapping past the end')
  equal(typeahead(opts, 0, 's'), 0, 'typeahead: matches labels case-insensitively, wrapping back to a lone match')
  equal(typeahead(opts, 0, 'xr'), 3, 'typeahead: falls back to ids')
  equal(typeahead(opts, 0, 'q'), -1, 'typeahead: no match')
  let t = { text: '', at: 0 }
  t = typedAfter(t, 'D', 10_000)
  t = typedAfter(t, 'O', 10_000 + TYPEAHEAD_MS)
  equal(t.text, 'do', 'typeahead: keys inside the pause extend the string, lowercased')
  equal(typedAfter(t, 'x', t.at + TYPEAHEAD_MS + 1).text, 'x', 'typeahead: a longer pause starts over')
}
