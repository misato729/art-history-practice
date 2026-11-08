export type SourceReference = { label: string; url: string | null }

/** The stored citation keeps authoring provenance; learners see only its public title/pages. */
export function stripSourceParentheses(value: string): string {
  let result = ''
  const stack: string[] = []
  for (const character of value) {
    if (character === '(' || character === '（') { stack.push(character === '(' ? ')' : '）'); continue }
    if (stack.length) { if (character === stack[stack.length - 1]) stack.pop(); continue }
    if (character !== ')' && character !== '）') result += character
  }
  return result.replace(/[ \t]+/g, ' ').trim()
}

export function publicSourceReferences(source: string | null | undefined): SourceReference[] {
  return (source ?? '').split('\n').flatMap(line => {
    const value = line.trim()
    if (!value) return []
    const separator = value.lastIndexOf('|')
    const rawLabel = separator === -1 ? value : value.slice(0, separator).trim()
    const candidate = separator === -1 ? '' : value.slice(separator + 1).trim()
    let url: URL | null = null
    try { if (/^https:\/\/[^\s]+$/.test(candidate)) url = new URL(candidate) } catch { /* Render malformed citations as plain text. */ }
    const label = stripSourceParentheses(url ? rawLabel : value)
    if (label) return [{ label, url: url ? candidate : null }]
    return url ? [{ label: url.hostname, url: candidate }] : []
  })
}

/** Learner APIs omit provenance metadata as well; database/admin source text remains intact. */
export function publicSourceText(source: string | null | undefined): string {
  return publicSourceReferences(source).map(reference => reference.url ? `${reference.label}|${reference.url}` : reference.label).join('\n')
}
