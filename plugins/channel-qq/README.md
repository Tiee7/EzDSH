# @ezdsh/channel-qq

QQ channel adapter for EzDSH remote control.

## Prerequisites

You need a running OneBot 11 server. Popular choices:

- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)
- [LLOneBot](https://github.com/LLOneBot/LLOneBot)
- [Lagrange.Onebot](https://github.com/LagrangeDev/Lagrange.Onebot)

## Configuration

Add to your EzDSH `channel-bridge.json` under `adapters.qq`:

```json
{
  "enabled": true,
  "adapters": {
    "qq": {
      "wsUrl": "ws://localhost:3001",
      "httpUrl": "http://localhost:3001",
      "accessToken": "optional"
    }
  },
  "allowList": []
}
```

## Notes

- This adapter only implements the OneBot 11 **client** side. The OneBot server must be started and managed separately.
- OneBot 11 does not support message reactions, so `setStatus` is a no-op.
- QQ group messages are treated as `chat.type: 'group'` with `chat.id` set to the group id.
