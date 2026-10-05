/**
 * Inline SVG icons. Emoji glyphs rendered inconsistently across platforms and
 * read as templated. All inherit `currentColor` and a shared 1.6 stroke so they
 * sit coherently next to the Dropdown chevrons.
 */
type IconProps = { className?: string; title?: string }

function Svg({
  className,
  title,
  children
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? 'h-4 w-4'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

export function IconSettings(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Svg>
  )
}

export function IconRefresh(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </Svg>
  )
}

export function IconEdit(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  )
}

export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconClose(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  )
}

export function IconPlus(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconArrowUp(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  )
}

export function IconOpenPane(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </Svg>
  )
}

/** Out to the system browser: a window open at its top-right corner with an arrow leaving through
 *  the gap. IconOpenPane's square box means the pane inside Clui. */
export function IconExternal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10 4H5.5A2.5 2.5 0 0 0 3 6.5v10A2.5 2.5 0 0 0 5.5 19h13a2.5 2.5 0 0 0 2.5-2.5V14" />
      <path d="M3 8.5h4.5" />
      <path d="M15.5 3H21v5.5M21 3l-7.5 7.5" />
    </Svg>
  )
}

export function IconStop(p: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={p.className ?? 'h-4 w-4'} fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  )
}

export function IconChevron(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  )
}

/** Luggage-style tag with its punched hole. */
export function IconTag(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <path d="M7 7h.01" />
    </Svg>
  )
}

/** Diagonal arrow tucking into a bottom-right corner: send a running tool to the background.
 *  Deliberately not the vertical download-arrow-onto-a-line. */
export function IconSendToTray(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="m5 5 10 10" />
      <path d="M15 9v6h-6" />
      <path d="M15 21h6v-6" />
    </Svg>
  )
}

// The editor panel-toggle glyph (⌘B convention). One shape for both states; the
// aria-label carries the direction.
export function IconSidebar(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </Svg>
  )
}

export function IconSliders(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M2 14h4M10 8h4M18 16h4" />
    </Svg>
  )
}

/** Triangle with a bang. Pairs with `text-warn` so a degraded state is signaled by SHAPE
 *  too, not amber alone (WCAG 1.4.1). */
export function IconWarn(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.6h.01" />
    </Svg>
  )
}

export function IconShield(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </Svg>
  )
}

/** Shield with a slash, "protection off". Used for the risky bypassPermissions
 *  ("Autonomous") mode so its danger is signaled by SHAPE, not color alone (WCAG 1.4.1). */
export function IconShieldOff(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="M4.5 4.5 19.5 19.5" />
    </Svg>
  )
}

// ── Permission-mode glyphs ───────────────────────────────────────────────────
// Each permission mode gets a DISTINCT metaphor glyph so the mode is legible by
// SHAPE, not by color alone (two modes shared green; WCAG 1.4.1). Reused
// elsewhere: IconSettings (System Default), IconEdit (Auto Edit).

/** No-entry (circle + horizontal bar), "Silent Deny": denies anything unlisted. */
export function IconNoEntry(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.5 12h9" />
    </Svg>
  )
}

/** Raised hand, "Interactive": stops to ask you before each tool. */
export function IconHand(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v3.5a5.5 5.5 0 0 1-5.5 5.5H12a5 5 0 0 1-4.3-2.5L6 17c-.7-1-.3-1.9.6-2.2l.9-.3V7.5a1.5 1.5 0 0 1 3 0V11" />
    </Svg>
  )
}

/** Sparkles, "Adaptive": Claude's classifier decides risk per action. */
export function IconSparkles(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3l1.6 3.9L17.5 8.5 13.6 10 12 14l-1.6-4L6.5 8.5l3.9-1.6z" />
      <path d="M18 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  )
}

/** Checklist document, "Plan Mode": proposes a plan before acting. */
export function IconChecklist(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M8.5 9l1 1 2-2.2" />
      <path d="M13 9h2.5" />
      <path d="M8.5 14l1 1 2-2.2" />
      <path d="M13 14h2.5" />
    </Svg>
  )
}

/** Download / export, a down-arrow into a tray. Used for the session-row export action. */
export function IconDownload(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3v12M8 11l4 4 4-4" />
      <path d="M5 21h14" />
    </Svg>
  )
}

export function IconFile(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </Svg>
  )
}

export function IconFolder(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Svg>
  )
}

export function IconFolderOpen(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Svg>
  )
}

export function IconCopy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  )
}

export function IconCheck(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  )
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  )
}

export function IconMessage(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </Svg>
  )
}

/** Framed picture with a sun + mountain: the "attach image" affordance. */
export function IconImage(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </Svg>
  )
}

/** Closed padlock: marks the effort readout as forced/locked while Ultra is on. */
export function IconLock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  )
}

/** Half-filled disc: an outlined circle with its right half filled solid. Marks an
 *  in_progress task. The solid region makes it distinct from the hollow pending circle
 *  in pure GREYSCALE. A thin partial arc over a faint track blurs into a full circle at
 *  16px, which reads as state-by-color-alone; a filled half does not. */
export function IconHalfRing(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Thin hollow circle: a not-yet-started (pending/created) task. */
export function IconCircle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
    </Svg>
  )
}

/** Pushpin: pins the task checklist panel open (aria-pressed carries the state; the
 *  glyph is the affordance, no accent tint). */
export function IconPin(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 17v5" />
      <path d="M9 10.8V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6.8a2 2 0 0 0 .5 1.3l1.5 1.7a1 1 0 0 1-.75 1.66H7.75A1 1 0 0 1 7 13.8l1.5-1.7a2 2 0 0 0 .5-1.3Z" />
    </Svg>
  )
}

/** A dashed square with a pointer over its corner: annotate an element of the page. */
export function IconTarget(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12.03 12.68a.5.5 0 0 1 .65-.65l9 3.5a.5.5 0 0 1-.03.95l-3.45 1.06a1 1 0 0 0-.66.66l-1.06 3.45a.5.5 0 0 1-.95.03Z" />
      <path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h2M14 3h1M3 9v1M21 9v2M3 14v1" />
    </Svg>
  )
}

/** Vertical kebab (⋮): the session-row overflow menu trigger for rare actions. */
export function IconMore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Svg>
  )
}

/** Ghost: marks an ephemeral ("Quick", not-saved) session, distinguished by shape, not color. */
export function IconGhost(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20V11a8 8 0 0 1 16 0V20l-4 2-4-2-4 2-4-2z" />
      <circle cx="9" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Git-branch glyph (a line diverging off a base): the "Branch session" action. */
export function IconGitFork(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="4" r="2" />
      <circle cx="18" cy="4" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="M6 6v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
      <path d="M12 12v6" />
    </Svg>
  )
}

export function IconMaximize(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Svg>
  )
}

export function IconRestore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </Svg>
  )
}

/** A page with Claude's pointer in its open corner: the browser Claude drives. Not a globe, which reads as web search. */
export function IconAgentBrowser(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 19H5.5A2.5 2.5 0 0 1 3 16.5v-10A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5V11" />
      <path d="M3 8.5h18" />
      <path d="M14 13l6.5 2.4-2.9 1.1-1.1 2.9Z" />
    </Svg>
  )
}

export function IconEye(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconEyeOff(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.15 5.47C10.02 5.17 10.97 5 12 5C18.5 5 22 12 22 12C22 12 21.08 13.84 19.31 15.63" />
      <path d="M14.85 18.53C13.98 18.83 13.03 19 12 19C5.5 19 2 12 2 12C2 12 2.92 10.16 4.69 8.37" />
      <path d="m4 4 16 16" />
    </Svg>
  )
}
