export interface EzDSHError {
  code: string
  message: string
  requestId: string
  retryable: boolean
}

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export interface IpcFailure {
  ok: false
  error: EzDSHError
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure

export function toEzDSHError(error: unknown, requestId: string): EzDSHError {
  return {
    code: typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'EzDSH 操作失败',
    requestId,
    retryable: true
  }
}
