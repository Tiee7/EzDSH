import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface DshRunnerOptions {
  /** Path to the Node executable. */
  nodeCommand: string
  /** Path to @deepseek-ai/dsh/lib/bin.js. */
  runtimeEntryPath: string
  /** Working directory for the headless session. */
  cwd?: string
  /** Maximum time to wait for the answer. */
  timeoutMs: number
}

export interface DshRunResult {
  answer: string
  exitCode: number | null
}

/**
 * Run one prompt through DSH's headless profile and return the final answer.
 */
export function runDshHeadless(
  prompt: string,
  options: DshRunnerOptions,
): Promise<DshRunResult> {
  return new Promise((resolve, reject) => {
    const args = [options.runtimeEntryPath, '--profile', 'headless', prompt]
    const child = spawn(options.nodeCommand, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const timeout = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
      reject(new Error(`DSH headless timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('exit', (exitCode) => {
      clearTimeout(timeout)
      if (killed) return
      resolve({
        answer: stdout.trim(),
        exitCode,
      })
    })
  })
}

export function killDshProcess(child: ChildProcess): void {
  if (!child.killed) {
    child.kill('SIGTERM')
  }
}
