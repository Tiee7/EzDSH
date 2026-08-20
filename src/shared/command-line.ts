export interface NormalizedCommand {
  command: string
  args: string[]
}

/** Accepts both a bare executable and a quoted/space-separated one-line command. */
export function normalizeCommandLine(command: string, args: readonly string[]): NormalizedCommand {
  const parts = splitCommandLine(command.trim())
  if (parts.length === 0) throw new Error('External service command is required')
  return {
    command: parts[0]!,
    args: [...parts.slice(1), ...args],
  }
}

function splitCommandLine(input: string): string[] {
  const parts: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  let tokenStarted = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote === 'single') {
      if (character === "'") quote = undefined
      else token += character
      tokenStarted = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') {
        quote = undefined
        tokenStarted = true
      } else if (character === '\\' && input[index + 1] === '"') {
        token += '"'
        index += 1
        tokenStarted = true
      } else {
        token += character
        tokenStarted = true
      }
      continue
    }
    if (character === "'") {
      quote = 'single'
      tokenStarted = true
    } else if (character === '"') {
      quote = 'double'
      tokenStarted = true
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        parts.push(token)
        token = ''
        tokenStarted = false
      }
    } else if (character === '\\' && input[index + 1] !== undefined && (/[\s]/u.test(input[index + 1]!) || input[index + 1] === '\\' || input[index + 1] === "'" || input[index + 1] === '"')) {
      token += input[index + 1]!
      index += 1
      tokenStarted = true
    } else {
      token += character
      tokenStarted = true
    }
  }

  if (quote !== undefined) throw new Error('External service command contains an unmatched quote')
  if (tokenStarted) parts.push(token)
  return parts
}
