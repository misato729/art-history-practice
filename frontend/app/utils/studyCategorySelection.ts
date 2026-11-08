import type { StudyCategoryNode } from '../../shared/schemas/study-categories.ts'

export type StudyPreset = 'world' | 'japanese'
export const categoryLeafCodes = (node: StudyCategoryNode): string[] => node.children.length
  ? node.children.flatMap(categoryLeafCodes) : [node.code]

export function presetCategoryCodes(tree: StudyCategoryNode[], preset: StudyPreset): string[] {
  const primary = tree.find(node => node.code === (preset === 'world' ? 'part_01' : 'part_02'))
  if (!primary?.children.length) return []
  if (preset === 'japanese') return categoryLeafCodes(primary)
  const eastern = tree.find(node => node.code === 'part_04')?.children.find(node => node.code === 'part_04_section_01')
  const western = categoryLeafCodes(primary).filter(code => !['part_01_section_05', 'part_01_section_12'].includes(code))
  return eastern ? [...western, ...categoryLeafCodes(eastern)] : []
}

export function categorySelectionState(selected: readonly string[], codes: readonly string[]) {
  const count = codes.filter(code => selected.includes(code)).length
  return { checked: codes.length > 0 && count === codes.length, indeterminate: count > 0 && count < codes.length }
}

export function toggleCategoryCodes(selected: readonly string[], codes: readonly string[], checked: boolean): string[] {
  return checked ? [...new Set([...selected, ...codes])] : selected.filter(code => !codes.includes(code))
}

export function presetSelectionState(tree: StudyCategoryNode[], selected: readonly string[], preset: StudyPreset) {
  const desired = presetCategoryCodes(tree, preset)
  const other = presetCategoryCodes(tree, preset === 'world' ? 'japanese' : 'world')
  const allowed = new Set([...desired, ...(categorySelectionState(selected, other).checked ? other : [])])
  const state = categorySelectionState(selected, desired)
  const extra = selected.some(code => !allowed.has(code))
  return { checked: state.checked && !extra, indeterminate: state.indeterminate || (state.checked && extra) }
}

/** A preset replaces manual extras; the other fully selected exam preset remains selected. */
export function toggleStudyPreset(tree: StudyCategoryNode[], selected: readonly string[], preset: StudyPreset, checked: boolean): string[] {
  const desired = presetCategoryCodes(tree, preset)
  if (!desired.length) return [...selected]
  if (!checked) return toggleCategoryCodes(selected, desired, false)
  const other = presetCategoryCodes(tree, preset === 'world' ? 'japanese' : 'world')
  return [...new Set([...desired, ...(categorySelectionState(selected, other).checked ? other : [])])]
}
