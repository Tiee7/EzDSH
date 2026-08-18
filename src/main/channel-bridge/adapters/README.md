# Channel Bridge Adapters

A channel bridge adapter connects EzDSH to an external IM platform (Feishu, DingTalk,
Slack, Discord, WeCom, etc.). Each adapter implements the same `ChannelAdapter`
interface so the core `ChannelBridgeService` does not need to know platform details.

## Adapter Interface

```ts
export interface ChannelAdapter {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(reply: ChannelReply): Promise<void>
  updateAllowList(allowList: string[]): void
  setStatus?(messageId: string, status: ChannelMessageStatus): Promise<void>
}
```

- `name` — unique adapter identifier, also used as the configuration key.
- `start` / `stop` — lifecycle hooks called by `ChannelBridgeService`.
- `send` — send a text reply to a user or group.
- `updateAllowList` — apply an updated user allowlist without restarting.
- `setStatus` *(optional)* — mark a message as `received`, `processing`, `done`, or `error`
  on the platform (e.g. Feishu uses a message reaction emoji).

Adapters receive incoming messages through the `onMessage` handler registered by
`ChannelBridgeService`.

## Adding a New Adapter

1. Create a new directory under `src/main/channel-bridge/adapters/<name>/`.
2. Define a `<name>Config` interface for platform-specific settings.
3. Implement `ChannelAdapter` in an `<name>Adapter` class.
4. Export a `ChannelAdapterFactory` named `<name>AdapterFactory`.
5. Register the factory in `src/main/index.ts`:

   ```ts
   import { dingtalkAdapterFactory } from './channel-bridge/adapters/dingtalk/index.js'
   registry.register(dingtalkAdapterFactory)
   ```

6. Users enable the adapter through `ChannelBridgeConfig.adapters.<name>`.

## Example Adapter Factory

```ts
export const exampleAdapterFactory: ChannelAdapterFactory = {
  name: 'example',
  create(options: ChannelAdapterCreateOptions): ChannelAdapter {
    return new ExampleAdapter({ ...options, config: options.config as ExampleConfig })
  },
}
```

## Built-in Adapters

- `feishu/` — Feishu / Lark
