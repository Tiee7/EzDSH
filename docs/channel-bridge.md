# EzDSH Channel Bridge / 远程控制

EzDSH Channel Bridge lets you send commands to DSH remotely through messaging platforms. The first supported adapter is **Feishu** (Lark).

EzDSH 远程控制功能让你通过即时通讯平台向 DSH 发送命令。当前首先支持 **飞书** 适配器。

---

## Architecture

```
Phone / Feishu
       │
       ▼
Feishu server ──long connection (WebSocket)──▶ EzDSH desktop app
                                                    │
                                                    ▼
                                        FeishuAdapter → ChannelBridgeService
                                                    │
                                                    ▼
                                          DSH --profile headless
                                                    │
                                                    ▼
                             Result sent back via Feishu OpenAPI (REST)
```

EzDSH uses the official `@larksuiteoapi/node-sdk` **WebSocket long connection** to receive Feishu events. This follows the OpenClaw channel-plugin design, but removes the need for a public webhook URL or ngrok: the desktop app only needs outbound access to the internet.

---

## Setup

### 1. Create a Feishu custom app

1. Go to [Feishu Open Platform](https://open.feishu.cn/).
2. Create an **enterprise self-built app** （企业自建应用）.
3. Enable **Bot** capability.
4. Grant these permissions:
   - `im:message:send_as_bot`
   - `im:message.group_msg`
   - `im:message.p2p_msg` (if you want private chat)
5. Publish the app to your tenant.
6. Copy the **App ID** and **App Secret**.

### 2. Configure the Feishu event subscription

In the Feishu app console:

1. Go to **Event Subscriptions** （事件订阅）.
2. Choose **Use long connection to receive events** （使用长连接接收事件）.
3. Add this event type:
   - `im.message.receive_v1`
4. Save.

No request URL, ngrok, or firewall rule is required.

### 3. Configure EzDSH

Open EzDSH → **Settings → 远程控制**.

| Field | Value |
|---|---|
| Enable remote control | On |
| Timeout | `120000` (ms) |
| Whitelist | Your Feishu `open_id` (one per line) |
| Feishu App ID | From step 1 |
| Feishu App Secret | From step 1 |
| Encrypt Key | Leave empty unless you enabled encryption in Feishu |

Click **Save**.

### 4. Find your Feishu open_id

The easiest way is to send a message to the bot, then check EzDSH logs. The log line prints the sender's `open_id`. Add it to the whitelist and save again.

Alternatively, call Feishu's `contact/v3/users/me` API after logging in.

### 5. Send commands

In a Feishu group or private chat where the bot is present, send:

```
what is 2+2
```

The bot will reply with DSH's answer.

---

## Security

- Events are received over an outbound WebSocket to Feishu; no local port is exposed to the internet.
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

This MVP implements the OpenClaw-style adapter pattern inside EzDSH's Electron main process using Feishu's official long connection. Later it can be refactored into:

- A proper DSH Cordis host plugin (`@ezdsh/channel-gateway`).
- Standalone adapter packages for WeChat, QQ, DingTalk, etc.
- A shared adapter protocol so third parties can contribute new platforms.
