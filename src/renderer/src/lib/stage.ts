/** Stage width at which the right sidebar can sit beside the transcript (half). The 520px primary
 *  and 440px secondary floors add up to it. */
export const SPLIT_MIN = 960

/** The Stage element: the scope for Stage-confined view transitions, and where --primary-w and
 *  --dock-lift are published. */
export function getStage(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-ui="stage"]')
}
