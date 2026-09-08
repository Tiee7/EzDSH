import { useState } from 'react'
import type { AppLocale } from '../../shared/locale.js'
import './store.css'

export function DshCommandPanel({ locale }: { locale: AppLocale }): JSX.Element {
  const zh = locale === 'zh'
  const [command, setCommand] = useState('dsh plugin --profile web add ')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setError(undefined)
    setOutput('')
    if (!window.confirm(zh
      ? '该命令将直接操作 DSH Profile，并可能安装第三方代码。\nEzDSH 无法审核该命令，您需要自行评估该命令的风险。\n\n[取消] [我了解风险，继续]'
      : 'This command directly operates on a DSH Profile and may install third-party code.\nEzDSH cannot audit this command; assess its risk yourself.')) return
    setBusy(true)
    try {
      const result = await window.EzDSH.dsh.run(command)
      setOutput(result.output || (zh ? '命令执行成功。' : 'Command completed successfully.'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <section className="dsh-command-panel">
    <header className="dsh-command-header">
      <div><h2>{zh ? '运行 DSH 命令' : 'Run DSH command'}</h2><p>{zh ? '使用 EzDSH 内置 Runtime 执行命令。' : 'Execute commands with the bundled DSH Runtime.'}</p></div>
    </header>
    <label className="dsh-command-label" htmlFor="dsh-command-input">{zh ? '命令' : 'Command'}</label>
    <textarea id="dsh-command-input" className="dsh-command-input" value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} rows={4} />
    <div className="dsh-command-actions"><button type="button" className="store-install-button" disabled={busy || command.trim() === ''} onClick={() => { void run() }}>{busy ? (zh ? '执行中…' : 'Running…') : (zh ? '执行命令' : 'Run command')}</button></div>
    {error ? <pre className="dsh-command-output dsh-command-error" role="alert">{error}</pre> : null}
    {output ? <pre className="dsh-command-output" role="status">{output}</pre> : null}
  </section>
}
