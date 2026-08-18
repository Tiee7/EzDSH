# @ezdsh/channel-wecom

WeCom (Enterprise WeChat) channel adapter for EzDSH remote control.

## Prerequisites

You need a WeCom enterprise account with a **self-built application (自建应用)**.

## Configuration

Add to your EzDSH `channel-bridge.json` under `adapters.wecom`:

```json
{
  "enabled": true,
  "adapters": {
    "wecom": {
      "corpId": "wwxxxxxxxxxxxxxxxx",
      "corpSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "agentId": 1000002,
      "token": "your_callback_token",
      "encodingAESKey": "your_43_char_encoding_aes_key",
      "callbackPort": 8081
    }
  },
  "allowList": []
}
```

## WeCom Admin Setup

1. Create a self-built application in the WeCom admin console.
2. Note the `AgentId` and `Secret`.
3. Enable "Receive Messages" and set the callback URL to `http://YOUR_HOST:callbackPort/`.
4. Set the callback token and encoding AES key; copy them into the config above.

## Notes

- This adapter starts a local HTTP server on `callbackPort` to receive WeCom callbacks.
- The callback URL must be reachable from the internet (use a reverse proxy or tunnel for local testing).
- WeCom self-built apps do not support message reactions, so `setStatus` is a no-op.
