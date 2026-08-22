import type { ReactNode } from 'react'

interface MarkdownListItem {
  readonly content: string
  readonly checked?: boolean
}

type MarkdownBlock =
  | { readonly type: 'heading'; readonly level: number; readonly content: string }
  | { readonly type: 'paragraph'; readonly lines: readonly string[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly MarkdownListItem[] }
  | { readonly type: 'blockquote'; readonly lines: readonly string[] }
  | { readonly type: 'code'; readonly language: string; readonly content: string }
  | { readonly type: 'thematic-break' }

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*$/
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const UNORDERED_ITEM_PATTERN = /^ {0,3}[-*+]\s+(.+)$/
const ORDERED_ITEM_PATTERN = /^ {0,3}\d+[.)]\s+(.+)$/
const BLOCKQUOTE_PATTERN = /^ {0,3}>\s?(.*)$/
const THEMATIC_BREAK_PATTERN = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isSetextHeadingAt(lines: readonly string[], index: number): boolean {
  return index + 1 < lines.length
    && !isBlank(lines[index])
    && /^ {0,3}(=+|-+)\s*$/.test(lines[index + 1])
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index]
  return FENCE_PATTERN.test(line)
    || HEADING_PATTERN.test(line)
    || THEMATIC_BREAK_PATTERN.test(line)
    || UNORDERED_ITEM_PATTERN.test(line)
    || ORDERED_ITEM_PATTERN.test(line)
    || BLOCKQUOTE_PATTERN.test(line)
    || isSetextHeadingAt(lines, index)
}

function parseListItem(content: string): MarkdownListItem {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(content)
  if (task === null) return { content }
  return { content: task[2], checked: task[1].toLowerCase() === 'x' }
}

/** Parse the block-level Markdown used by catalog descriptions without evaluating HTML. */
export function parseMarkdownBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index += 1
      continue
    }

    const fence = FENCE_PATTERN.exec(lines[index])
    if (fence !== null) {
      const fenceMarker = fence[1]
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^ {0,3}${fenceMarker[0]}{${fenceMarker.length},}\\s*$`).test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', language: fence[2], content: codeLines.join('\n') })
      continue
    }

    const heading = HEADING_PATTERN.exec(lines[index])
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length, content: heading[2] })
      index += 1
      continue
    }

    if (isSetextHeadingAt(lines, index)) {
      blocks.push({
        type: 'heading',
        level: lines[index + 1].trimStart().startsWith('=') ? 1 : 2,
        content: lines[index].trim()
      })
      index += 2
      continue
    }

    if (THEMATIC_BREAK_PATTERN.test(lines[index])) {
      blocks.push({ type: 'thematic-break' })
      index += 1
      continue
    }

    const unorderedItem = UNORDERED_ITEM_PATTERN.exec(lines[index])
    const orderedItem = ORDERED_ITEM_PATTERN.exec(lines[index])
    if (unorderedItem !== null || orderedItem !== null) {
      const ordered = orderedItem !== null
      const items: MarkdownListItem[] = []
      while (index < lines.length) {
        const item = (ordered ? ORDERED_ITEM_PATTERN : UNORDERED_ITEM_PATTERN).exec(lines[index])
        if (item === null) break
        items.push(parseListItem(item[1]))
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const quote = BLOCKQUOTE_PATTERN.exec(lines[index])
    if (quote !== null) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const quoteLine = BLOCKQUOTE_PATTERN.exec(lines[index])
        if (quoteLine === null) break
        quoteLines.push(quoteLine[1])
        index += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    const paragraphLines: string[] = [lines[index]]
    index += 1
    while (index < lines.length && !isBlank(lines[index]) && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index])
      index += 1
    }
    blocks.push({ type: 'paragraph', lines: paragraphLines })
  }

  return blocks
}

function safeHref(value: string): string | undefined {
  const href = value.trim()
  try {
    const protocol = new URL(href, 'https://ezdsh.invalid').protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? href : undefined
  } catch {
    return undefined
  }
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()#+.!>~-])/g, '$1')
}

function renderPlainText(value: string, keyPrefix: string): ReactNode[] {
  const parts = value.split('\n')
  const nodes: ReactNode[] = []
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-break-${index}`} />)
    if (part !== '') nodes.push(unescapeMarkdown(part))
  })
  return nodes
}

function renderInline(value: string, keyPrefix = 'inline'): ReactNode[] {
  const tokenPattern = /(`+[^`\n]+`+|\[[^\]]+\]\([^\s)]+(?:\s+["'][^)]*["'])?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let tokenIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderPlainText(value.slice(lastIndex, match.index), `${keyPrefix}-text-${tokenIndex}`))
    }

    const token = match[0]
    const key = `${keyPrefix}-token-${tokenIndex}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.replace(/^`+|`+$/g, '').replace(/\s+/g, ' ').trim()}</code>)
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^)]*["'])?\)$/.exec(token)
      const href = link === null ? undefined : safeHref(link[2])
      if (link !== null && href !== undefined) {
        nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer">{renderInline(link[1], `${key}-label`)}</a>)
      } else {
        nodes.push(...renderPlainText(token, key))
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>)
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
    }
    lastIndex = tokenPattern.lastIndex
    tokenIndex += 1
  }

  if (lastIndex < value.length) {
    nodes.push(...renderPlainText(value.slice(lastIndex), `${keyPrefix}-tail`))
  }
  return nodes
}

function MarkdownBlocks({ blocks }: { blocks: readonly MarkdownBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        const key = `markdown-block-${index}`
        switch (block.type) {
          case 'heading': {
            const Heading = `h${block.level}` as keyof JSX.IntrinsicElements
            return <Heading key={key}>{renderInline(block.content, key)}</Heading>
          }
          case 'paragraph':
            return <p key={key}>{renderInline(block.lines.join('\n'), key)}</p>
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-item-${itemIndex}`}>
                    {item.checked !== undefined
                      ? <input type="checkbox" checked={item.checked} readOnly aria-label={item.checked ? 'Completed' : 'Incomplete'} />
                      : null}
                    {renderInline(item.content, `${key}-item-${itemIndex}`)}
                  </li>
                ))}
              </List>
            )
          }
          case 'blockquote':
            return <blockquote key={key}><MarkdownBlocks blocks={parseMarkdownBlocks(block.lines.join('\n'))} /></blockquote>
          case 'code':
            return <pre key={key}><code className={block.language !== '' ? `language-${block.language}` : undefined}>{block.content}</code></pre>
          case 'thematic-break':
            return <hr key={key} />
        }
      })}
    </>
  )
}

/** Render catalog Markdown as React elements; raw HTML is intentionally treated as text. */
export function MarkdownContent({ markdown }: { markdown: string }): JSX.Element {
  return <div className="markdown-content"><MarkdownBlocks blocks={parseMarkdownBlocks(markdown)} /></div>
}
