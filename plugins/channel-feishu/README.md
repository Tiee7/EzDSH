# @ezdsh/channel-feishu

Feishu / Lark channel adapter for EzDSH remote control.

## Configuration

Add to your EzDSH `channel-bridge.json` under `adapters.feishu`:

```json
{
  "enabled": true,
  "adapters": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "encryptKey": "optional"
    }
  },
  "allowList": []
}
```

## Features

- Receive text messages via Feishu WebSocket event dispatcher
- Reply to private chats and groups
- Pairing flow for allowlist management
- Processing status shown as a message reaction emoji

## Packaging

This package is loaded by EzDSH's `ChannelAdapterLoader`. The entry point
is declared in `package.json` under `ezdsh.channelAdapter.entry`.
