# EzDSH Channel Bridge / 远程控制

EzDSH Channel Bridge lets you send commands to DSH remotely through messaging platforms. The first supported adapter is **Feishu** (Lark).

EzDSH 远程控制功能让你通过即时通讯平台向 DSH 发送命令。当前首先支持 **飞书** 适配器。

---

## Architecture

```
Phone / Feishu
       │
       ▼
Feishu server ──event──▶ Your public webhook URL
                              │
                              ▼
                    ngrok / reverse proxy
                              │
                              ▼
              EzDSH local HTTP server (127.0.0.1:17891)
                              │
                              ▼
              FeishuAdapter → ChannelBridgeService
                              │
                              ▼
                    DSH --profile headless
                              │
                              ▼
              Result sent back via Feishu OpenAPI
```

This follows the OpenClaw channel-plugin design: a thin gateway plus platform-specific adapters that all speak the same message shape.

---

## Setup

### 1. Create a Feishu custom app

1. Go to [Feishu Open Platform](https://open.feishu.cn/).
2. Create a custom app.
3. Enable **Bot** capability.
4. Grant these permissions:
   - `im:message:send_as_bot`
   - `im:message.group_msg`
   - `im:message.p2p_msg` (if you want private chat)
5. Publish the app to your tenant.
6. Copy the **App ID** and **App Secret**.

### 2. Expose EzDSH to the internet

EzDSH only listens on `127.0.0.1`. You need a public HTTPS URL that forwards to it.

Example using [ngrok](https://ngrok.com/):

```sh
ngrok http http://127.0.0.1:17891
```

Copy the HTTPS forwarding URL, e.g. `https://abcd-1234.ngrok-free.app`.

### 3. Configure the Feishu event subscription

In the Feishu app console:

1. Go to **Event Subscriptions**.
2. Set **Request URL** to: `https://<your-ngrok>/webhook/feishu`
3. Add these event types:
   - `im.message.receive_v1`
4. Save. Feishu will send a URL verification challenge; EzDSH responds automatically.

### 4. Configure EzDSH

Open EzDSH → **Settings → 远程控制**.

| Field | Value |
|---|---|
| Enable remote control | On |
| Local port | `17891` |
| Timeout | `120000` (ms) |
| Whitelist | Your Feishu `open_id` (one per line) |
| Feishu App ID | From step 1 |
| Feishu App Secret | From step 1 |
| Encrypt Key | Leave empty for the prototype |

Click **Save**.

### 5. Find your Feishu open_id

The easiest way is to send a message to the bot, then check EzDSH logs. The log line prints the sender's open_id. Add it to the whitelist and save again.

Alternatively, call Feishu's `contact/v3/users/me` API after logging in.

### 6. Send commands

In a Feishu group or private chat where the bot is present, send:

```
what is 2+2
```

The bot will reply with DSH's answer.

---

## Security

- The HTTP server only binds to `127.0.0.1`.
- Only Feishu user IDs in the whitelist can trigger commands.
- Every command runs in a fresh `dsh --profile headless` session, isolated from the GUI session.
- The credentials file is saved with mode `0o600`.

**Warning**: whitelisted users can run arbitrary shell commands through DSH. Only add trusted users.

---

## Configuration file

The config is stored in EzDSH state directory as `channel-bridge.json`:

```json
{
  "enabled": true,
  "port": 17891,
  "allowList": ["ou_xxxxxxxx"],
  "timeoutMs": 120000,
  "feishu": {
    "appId": "cli_xxxxxxxx",
    "appSecret": "xxxxxxxx"
  }
}
```

---

## Future work

This MVP implements the OpenClaw-style adapter pattern inside EzDSH's Electron main process. Later it can be refactored into:

- A proper DSH Cordis host plugin (`@ezdsh/channel-gateway`).
- Standalone adapter packages for WeChat, QQ, DingTalk, etc.
- A shared adapter protocol so third parties can contribute new platforms.
