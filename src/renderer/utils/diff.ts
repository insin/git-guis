export type ParsedDiffLine = {
  kind: 'context' | 'add' | 'del' | 'meta'
  text: string
  visibleLine?: number
  oldLine?: number
  newLine?: number
}

export type ParsedHunk = {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: ParsedDiffLine[]
}

export type ParsedFileDiff = {
  header: string[]
  hunks: ParsedHunk[]
}

export type DiffLineSelection = {
  start: number
  end: number
}

export function parseUnifiedDiff(patch: string): ParsedFileDiff {
  const lines = patch.split('\n')
  const header: string[] = []
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? '1'),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? '1'),
        lines: [],
      }
      oldLine = current.oldStart
      newLine = current.newStart
      hunks.push(current)
      continue
    }

    if (!current) {
      if (line.length > 0) header.push(line)
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push({ kind: 'add', text: line.slice(1), newLine })
      newLine += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push({ kind: 'del', text: line.slice(1), oldLine })
      oldLine += 1
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (line.startsWith('\\ ')) {
      current.lines.push({ kind: 'meta', text: line })
    }
  }

  return { header, hunks }
}

export function buildHunkPatch(patch: string, hunkIndex: number) {
  const lines = patch.split('\n')
  const hunkStarts = lines
    .map((line, index) => (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? index : -1))
    .filter((index) => index !== -1)
  const start = hunkStarts[hunkIndex]
  if (start === undefined) return null

  let end = hunkStarts[hunkIndex + 1] ?? lines.length
  while (end > start && lines[end - 1] === '') end -= 1

  return [...lines.slice(0, hunkStarts[0]), ...lines.slice(start, end), ''].join('\n')
}

export function buildSelectionPatch(
  patch: string,
  selection: DiffLineSelection | null,
  reverse = false,
) {
  if (!selection) return null
  const parsed = withVisibleLineNumbers(parseUnifiedDiff(patch))
  const selectedHunks = parsed.hunks
    .map((hunk) => renderPartialHunk(hunk, selection, reverse))
    .filter((hunk): hunk is string => Boolean(hunk))

  if (selectedHunks.length === 0) return null
  return [...parsed.header, ...selectedHunks, ''].join('\n')
}

export function selectedDiffText(patch: string, selection: DiffLineSelection | null) {
  if (!selection) return null
  const parsed = withVisibleLineNumbers(parseUnifiedDiff(patch))
  const isNewFile = parsed.header.some(
    (line) => line === '--- /dev/null' || line === 'new file mode 100644',
  )
  const start = Math.min(selection.start, selection.end)
  const end = Math.max(selection.start, selection.end)
  const lines = parsed.hunks.flatMap((hunk) => {
    const selectedLines = hunk.lines.filter(
      (line) =>
        line.visibleLine !== undefined && line.visibleLine >= start && line.visibleLine <= end,
    )
    if (selectedLines.length === 0) return []
    return [
      hunk.header,
      ...selectedLines.map((line) =>
        isNewFile && line.kind === 'add' ? line.text : renderLine(line),
      ),
    ]
  })

  return lines.length > 0 ? lines.join('\n') : null
}

function renderPartialHunk(hunk: ParsedHunk, selection: DiffLineSelection, reverse: boolean) {
  const rendered: string[] = []
  const preContext: string[] = []
  let oldCount = 0
  let newCount = 0
  let changed = false

  const flushPreContext = () => {
    rendered.push(...preContext)
    preContext.length = 0
  }

  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      flushPreContext()
      rendered.push(` ${line.text}`)
      oldCount += 1
      newCount += 1
      continue
    }

    if (line.kind === 'meta') {
      flushPreContext()
      rendered.push(line.text)
      continue
    }

    if (isChangedLineSelected(line, selection)) {
      changed = true
      if (line.kind === 'del') {
        oldCount += 1
        flushPreContext()
        rendered.push(renderLine(line))
      } else {
        newCount += 1
        rendered.push(renderLine(line))
      }
      continue
    }

    const becomesContext = reverse ? line.kind === 'add' : line.kind === 'del'
    if (becomesContext) {
      oldCount += 1
      newCount += 1
      const contextLine = ` ${line.text}`
      if (line.kind === 'del') preContext.push(contextLine)
      else rendered.push(contextLine)
    } else {
      flushPreContext()
    }
  }

  if (!changed) return null
  flushPreContext()
  return [`@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart},${newCount} @@`, ...rendered].join(
    '\n',
  )
}

export function withVisibleLineNumbers(parsed: ParsedFileDiff): ParsedFileDiff {
  let visibleLine = 0
  return {
    ...parsed,
    hunks: parsed.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => {
        visibleLine += 1
        return { ...line, visibleLine }
      }),
    })),
  }
}

function isChangedLineSelected(line: ParsedDiffLine, selection: DiffLineSelection) {
  if (line.kind !== 'add' && line.kind !== 'del') return false
  if (line.visibleLine === undefined) return false
  const start = Math.min(selection.start, selection.end)
  const end = Math.max(selection.start, selection.end)
  return line.visibleLine >= start && line.visibleLine <= end
}

function renderLine(line: ParsedDiffLine) {
  if (line.kind === 'add') return `+${line.text}`
  if (line.kind === 'del') return `-${line.text}`
  if (line.kind === 'context') return ` ${line.text}`
  return line.text
}
