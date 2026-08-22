import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from '../../src/renderer/store/MarkdownContent'

describe('store Markdown blocks', () => {
  it('parses headings, lists, fenced code, and quotes', () => {
    const blocks = parseMarkdownBlocks('# Title\n\n- one\n- [x] two\n\n```yaml\nname: demo\n```\n\n> note')

    expect(blocks).toEqual([
      { type: 'heading', level: 1, content: 'Title' },
      {
        type: 'list',
        ordered: false,
        items: [{ content: 'one' }, { content: 'two', checked: true }]
      },
      { type: 'code', language: 'yaml', content: 'name: demo' },
      { type: 'blockquote', lines: ['note'] }
    ])
  })

  it('keeps raw HTML as content instead of creating executable markup', () => {
    const blocks = parseMarkdownBlocks('<script>alert(1)</script>')
    expect(blocks).toEqual([{ type: 'paragraph', lines: ['<script>alert(1)</script>'] }])
  })
})
