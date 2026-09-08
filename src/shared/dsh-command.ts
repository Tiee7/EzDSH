/** Parse a user-entered DSH command without invoking a shell. */
export function parseDshCommand(input: string): readonly string[] {
  const source = input.trim()
  if (source === '') throw new Error('请输入 DSH 命令')
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaping = false
  for (const character of source) {
    if (escaping) { token += character; escaping = false; continue }
    if (character === '\\' && quote !== "'") { escaping = true; continue }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (token !== '') { tokens.push(token); token = '' }
    } else token += character
  }
  if (escaping || quote !== undefined) throw new Error('命令包含未闭合的引号或转义符')
  if (token !== '') tokens.push(token)
  if (tokens[0] !== 'dsh') throw new Error('这里只能运行以 dsh 开头的命令')
  return tokens
}
