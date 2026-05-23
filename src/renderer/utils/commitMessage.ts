const WRAP_WIDTH = 72

export function formatCommitMessage(input: string) {
  const trimmed = input.trimEnd()
  if (!trimmed) return ''

  const [subject = '', ...bodyLines] = trimmed.split('\n')
  if (bodyLines.length === 0) return subject

  const paragraphs = bodyLines.join('\n').split(/\n{2,}/)
  const wrapped = paragraphs.map((paragraph) => wrapParagraph(paragraph)).join('\n\n')
  return `${[subject, wrapped].join('\n').trimEnd()}\n`
}

function wrapParagraph(paragraph: string) {
  const lines = paragraph.split('\n')
  if (lines.some((line) => shouldPreserveLine(line))) return paragraph

  const words = paragraph.trim().split(/\s+/)
  const output: string[] = []
  let current = ''

  for (const word of words) {
    if (current.length === 0) {
      current = word
      continue
    }

    if (current.length + 1 + word.length > WRAP_WIDTH) {
      output.push(current)
      current = word
      continue
    }

    current += ` ${word}`
  }

  if (current) output.push(current)
  return output.join('\n')
}

function shouldPreserveLine(line: string) {
  return (
    line.startsWith(' ') ||
    line.startsWith('\t') ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^[A-Za-z-]+:\s+\S/.test(line)
  )
}
