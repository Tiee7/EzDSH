export { normalizeCommandLine as normalizeExternalServiceCommand } from '../../shared/command-line.js'
export type { NormalizedCommand as NormalizedExternalServiceCommand } from '../../shared/command-line.js'

import type { ExternalServiceStartupIssue } from '../../shared/external-services.js'
import type { AppCopy } from '../../shared/locale.js'

export interface ExternalServiceIssueDisplay {
  summary: string
  field?: 'cwd' | 'command'
}

/** Use structured process evidence, never infer a cause from error text in the renderer. */
export function describeExternalServiceStartupIssue(copy: AppCopy, issue: ExternalServiceStartupIssue): ExternalServiceIssueDisplay {
  switch (issue.code) {
    case 'cwd-missing': return { summary: copy.externalServicesCwdMissing, field: 'cwd' }
    case 'cwd-not-directory': return { summary: copy.externalServicesCwdNotDirectory, field: 'cwd' }
    case 'cwd-inaccessible': return { summary: copy.externalServicesCwdInaccessible, field: 'cwd' }
    case 'command-not-found': return { summary: copy.externalServicesCommandNotFound, field: 'command' }
    case 'command-not-executable': return { summary: copy.externalServicesCommandNotExecutable, field: 'command' }
    case 'command-unavailable': return { summary: copy.externalServicesCommandUnavailable, field: 'command' }
    default: return { summary: copy.externalServicesStartupUnknown }
  }
}
