import type { CluiSettings, ResolvedSettings, SettingsKey } from '../../../../shared/settings'

/** Keys saved the moment they change, by their own controls or the app chrome. Save never sends
 *  them, so it can't overwrite a newer value with the one the modal opened with. */
type ImmediateKey =
  | 'browserEnabled'
  | 'linkTarget'
  | 'annotateScreenshots'
  | 'onboarded'
  | 'sidebarCollapsed'
  | 'sidebarWidth'
  | 'subagentPaneFull'
export type StagedKey = Exclude<SettingsKey, ImmediateKey>

/** The modal's staged edits over the last settings it saw. Save sends only `edits` and `resets`. */
export interface Draft {
  saved: ResolvedSettings
  edits: Partial<Pick<CluiSettings, StagedKey>>
  resets: SettingsKey[]
}

export const draftValues = (d: Draft): CluiSettings => ({ ...d.saved.values, ...d.edits })

export const isDirty = (d: Draft): boolean => Object.keys(d.edits).length > 0 || d.resets.length > 0

export const isOverridden = (d: Draft, key: SettingsKey): boolean =>
  d.saved.sources[key] === 'override' && !d.resets.includes(key)

/** Editing a field un-stages its reset. Picking the saved value again leaves the field clean. */
export function editDraft<K extends StagedKey>(d: Draft, key: K, value: CluiSettings[K]): Draft {
  const { [key]: _, ...edits } = d.edits
  return {
    ...d,
    edits: value === d.saved.values[key] ? edits : { ...edits, [key]: value },
    resets: d.resets.filter((k) => k !== key)
  }
}

export const resetDraft = (d: Draft, key: SettingsKey): Draft =>
  d.resets.includes(key) ? d : { ...d, resets: [...d.resets, key] }

/** Adopt newer saved settings. Clean fields follow them; a staged edit survives unless it now
 *  matches, and a staged reset survives unless there is no longer an override to clear. */
export function rebaseDraft(d: Draft | null, saved: ResolvedSettings): Draft {
  if (!d) return { saved, edits: {}, resets: [] }
  const edits = Object.fromEntries(
    Object.entries(d.edits).filter(([k, v]) => v !== saved.values[k as StagedKey])
  ) as Draft['edits']
  return { saved, edits, resets: d.resets.filter((k) => saved.sources[k] === 'override') }
}

/** What Save sends. A reset wins over an edit to the same key, matching main's clear-first order. */
export function draftPatch(d: Draft): { patch: Partial<CluiSettings>; clear: SettingsKey[] } {
  const patch = Object.fromEntries(
    Object.entries(d.edits).filter(([k]) => !d.resets.includes(k as SettingsKey))
  ) as Partial<CluiSettings>
  return { patch, clear: d.resets }
}
