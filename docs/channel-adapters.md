# Channel Adapters

EzDSH can be controlled from external IM platforms through **channel adapters**. Each adapter is a standalone plugin that speaks the platform's protocol; EzDSH core only knows the generic `ChannelAdapter` interface.

## Built-in Adapters

| Platform | Package | Protocol |
|----------|---------|----------|
| Feishu / Lark | `plugins/channel-feishu` | Official `@larksuiteoapi/node-sdk` |
| QQ | `plugins/channel-qq` | OneBot 11 (NapCatQQ, LLOneBot, Lagrange.Onebot, etc.) |
| WeCom (Enterprise WeChat) | `plugins/channel-wecom` | Official WeCom self-built application API |

## How Adapters Are Loaded

When EzDSH starts, `ChannelAdapterLoader` scans two directories:

1. Built-in adapters: `<appPath>/plugins/channel-*`
2. User-installed adapters: `<dshHome>/channel-adapters/<id>/`

Each adapter package must contain a `package.json` with an `ezdsh.channelAdapter` manifest:

```json
{
  "name": "@ezdsh/channel-example",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "ezdsh": {
    "channelAdapter": {
      "name": "example",
      "entry": "./src/index.js"
    }
  }
}
```

The entry module must export a `ChannelAdapterFactory`:

```js
export const exampleAdapterFactory = {
  name: 'example',
  create(options) {
    return new ExampleAdapter(options)
  }
}
```

## Adapter Interface

```ts
interface ChannelAdapter {
  readonly name: string
  onMessage(handler: (message: ChannelMessage) => Promise<ChannelReply | undefined>): void
  start(): Promise<void>
  stop(): Promise<void>
  send(reply: ChannelReply): Promise<void>
  updateAllowList(allowList: string[]): void
  setStatus?(messageId: string, status: ChannelMessageStatus): Promise<void>
}
```

- `name` — matches the configuration key under `adapters`.
- `onMessage` — register the handler that processes incoming messages.
- `start` / `stop` — lifecycle hooks.
- `send` — send a reply back to the platform.
- `updateAllowList` — apply an updated user allowlist without restarting.
- `setStatus` *(optional)* — mark a message as `processing`, `done`, or `error` on the platform.

## Configuration

Adapters are enabled in `channel-bridge.json` under the `adapters` object:

```json
{
  "enabled": true,
  "adapters": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx"
    },
    "qq": {
      "wsUrl": "ws://localhost:3001",
      "httpUrl": "http://localhost:3001"
    },
    "wecom": {
      "corpId": "ww_xxx",
      "corpSecret": "xxx",
      "agentId": 1000002,
      "token": "callback_token",
      "encodingAESKey": "xxx",
      "callbackPort": 8081
    }
  },
  "allowList": []
}
```

See each adapter's `README.md` for platform-specific setup.

## Adding a New Adapter

1. Create `plugins/channel-<name>/`.
2. Add `package.json` with the `ezdsh.channelAdapter` manifest.
3. Implement `ChannelAdapter` in the entry module.
4. Add tests under `test/channel-bridge/<name>.test.ts`.
5. Optionally add a demo catalog entry in `src/main/store/demo-catalog.ts`.

## Skill Market

Adapters can also be distributed through the EzDSH store as `channel-adapter` entries. The `StoreService` installs them into `<dshHome>/channel-adapters/<id>/`, where the loader discovers them on the next EzDSH start.
