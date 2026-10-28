// Mermaid: the locked-down config a directive can't loosen, error lines mapped back to the file, and which flowchart
// nodes are proven to sit on one source line.
import mermaid from 'mermaid'
import { contrast, failureOf, MAX_EDGES, mermaidConfig, nodeLines, pageInkOn, SECURE, sourceIdOf, sourceLine, typeName, type Tokens } from '../src/renderer/src/lib/mermaid.ts'
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
