declare module 'ws' {
  import { EventEmitter } from 'node:events'

  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export interface ClientOptions {
    headers?: Record<string, string>
  }

  export default class WebSocket extends EventEmitter {
    constructor(address: string | URL, options?: ClientOptions)
    send(data: string): void
    close(): void
    removeAllListeners(event?: string | symbol): this
  }
}
