/**
 * First-run onboarding. Two distinct states, both rendered in the main pane
 * (replacing the Welcome content) when there's no active session:
 *
 *  1. CLI HEALTH GATE (blocking) — if the `claude` CLI isn't found, or is found but
 *     `--version` fails (broken install), show a setup card with the install command,
 *     a "set path manually" link into Settings, and a re-check button. This is the
 *     load-bearing piece: without a working CLI, Clui can do NOTHING, and today the
 *     only signal is tiny red footer text (a dead end). Gates on the LIVE detectCli
 *     result, independent of the onboarded flag — a CLI that breaks later re-gates.
 *
 *  2. FIRST-RUN INTRO (dismissible) — only when the CLI is healthy AND the user has
 *     never onboarded: one lightweight card naming what Clui adds, then "Pick a
 *     workspace". Dismiss (or picking a workspace) sets the persisted `onboarded`
 *     flag so it never reshows. Deliberately ONE card, not a multi-step tour
 *     (forced multi-step onboarding gets skipped — NN/g).
 *
 * When the CLI is healthy and the user is already onboarded, this renders nothing
 * (App falls through to its normal Welcome pane).
 */
import { Button } from './Button'
import { IconPlus, IconSettings, IconRefresh } from './Icon'
import type { CliInfo } from '../../../shared/ipc'

/** CLI health derived from a CliInfo: 'ok' | 'missing' (not found) | 'broken' (found, no version). */
export type CliHealth = 'ok' | 'missing' | 'broken'

export function cliHealth(info: CliInfo | null): CliHealth {
  if (!info || info.source === 'not-found' || !info.path) return 'missing'
  if (!info.version) return 'broken'
  return 'ok'
}

/** The Homebrew-first install hint (matches how this machine has it; the docs URL is
 *  the canonical fallback for non-brew setups). Shown as copy-pasteable mono text. */
const INSTALL_CMD = 'brew install --cask claude-code'
const INSTALL_URL = 'https://claude.com/claude-code'

export function Onboarding({
  cliInfo,
  onboarded,
  onOpenSettings,
  onRecheck,
  onPickWorkspace,
  onDismissIntro
}: {
  cliInfo: CliInfo | null
  onboarded: boolean
  onOpenSettings: () => void
  onRecheck: () => void
  onPickWorkspace: () => void
  onDismissIntro: () => void
}): JSX.Element | null {
  const health = cliHealth(cliInfo)

  // 1) Blocking CLI setup card — takes precedence over everything.
  if (health !== 'ok') {
    const broken = health === 'broken'
    return (
      <div className="m-auto flex max-w-md flex-col items-center px-6 text-center">
        <div className="mb-5 flex items-baseline gap-2.5">
          <span className="font-serif text-4xl font-semibold tracking-tight text-content">Clui</span>
          <span className="h-2 w-2 translate-y-[-5px] rounded-full bg-accent" aria-hidden="true" />
        </div>
        <h2 className="font-serif text-xl text-content">
          {broken ? 'The claude CLI isn’t responding' : 'Clui needs the claude CLI'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-dim">
          {broken ? (
            <>
              A <span className="font-mono text-content">claude</span> binary was found at{' '}
              {/* The offending path is the key diagnostic fact — give it FULL emphasis
                  (was text-faint, the least-emphasized span in its own sentence). */}
              <span className="break-all font-mono text-content">{cliInfo?.path}</span>, but{' '}
              <span className="font-mono text-content">claude --version</span> failed. It may be a
              broken install or the wrong file. Set the correct path, then re-check.
            </>
          ) : (
            <>
              Clui is a window onto the <span className="font-mono text-content">claude</span> command-
              line tool — it drives your installed CLI, it doesn’t replace it. Install it, then re-check.
            </>
          )}
        </p>

        {!broken && (
          <div className="mt-5 w-full rounded-lg border border-border bg-tool px-4 py-3 text-left">
            <span className="text-[11px] uppercase tracking-wide text-faint">Install</span>
            <p className="mt-1 select-all font-mono text-sm text-content">{INSTALL_CMD}</p>
            <p className="mt-2 text-xs text-faint">
              Or see{' '}
              <button
                type="button"
                className="text-accent underline-offset-2 hover:underline"
                onClick={() => void window.clui.openExternal(INSTALL_URL)}
              >
                claude.com/claude-code
              </button>{' '}
              for other platforms.
            </p>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button variant="primary" size="md" onClick={onRecheck}>
            <IconRefresh className="h-4 w-4" />
            Re-check
          </Button>
          <Button variant="secondary" size="md" onClick={onOpenSettings}>
            <IconSettings className="h-4 w-4" />
            Set path manually
          </Button>
        </div>
      </div>
    )
  }

  // 2) First-run intro — healthy CLI, never onboarded.
  if (!onboarded) {
    return (
      <div className="m-auto flex max-w-md flex-col items-center px-6 text-center">
        <div className="mb-6 flex items-baseline gap-2.5">
          <span className="font-serif text-5xl font-semibold tracking-tight text-content">Clui</span>
          <span className="h-2.5 w-2.5 translate-y-[-6px] rounded-full bg-accent" aria-hidden="true" />
        </div>
        <p className="font-serif text-xl italic leading-snug text-dim">Drive Claude Code, visually.</p>
        <p className="mt-2 text-sm text-faint">
          Connected to <span className="font-mono text-dim">claude {cliInfo?.version}</span>. Here’s what
          Clui adds:
        </p>
        <ul className="mt-5 w-full space-y-3 text-left">
          <IntroPoint title="Run sessions side by side">
            Keep several Claude Code sessions live at once — switch between them without losing context.
          </IntroPoint>
          <IntroPoint title="See and control permissions">
            Approve or deny tool calls in a dialog, and set how much Claude can do on its own — per session.
          </IntroPoint>
          <IntroPoint title="Watch the work unfold">
            Streamed replies, tool calls, subagents, and workflows rendered visually as they run.
          </IntroPoint>
        </ul>
        <div className="mt-7 flex items-center gap-2">
          <Button variant="primary" size="lg" onClick={onPickWorkspace}>
            <IconPlus className="h-4 w-4" />
            Pick a workspace
          </Button>
          <Button variant="ghost" size="lg" onClick={onDismissIntro}>
            Skip
          </Button>
        </div>
      </div>
    )
  }

  // Healthy + onboarded → App renders its normal Welcome pane.
  return null
}

function IntroPoint({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <span>
        <span className="text-sm font-medium text-content">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-faint">{children}</span>
      </span>
    </li>
  )
}
