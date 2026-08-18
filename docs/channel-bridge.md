# EzDSH Channel Bridge / 远程控制

EzDSH Channel Bridge lets you send commands to DSH remotely through messaging platforms. The first supported adapter is **Feishu** (Lark).

EzDSH 远程控制功能让你通过即时通讯平台向 DSH 发送命令。当前首先支持 **飞书** 适配器。

---

## Architecture

```
Phone / Feishu
       │
       ▼
Feishu server ──WebSocket long connection──▶ EzDSH desktop app
                                                    │
                                                    ▼
                                              FeishuAdapter
                                                    │
                                                    ▼
                                          EzDSH DSH Runtime
                                                    │
                                                    ▼
                              Target session (shared with the GUI)
                                                    │
                                                    ▼
                                    Result sent back via Feishu OpenAPI
```

EzDSH uses the official `@larksuiteoapi/node-sdk` **WebSocket long connection** to receive Feishu events, so no public webhook URL or ngrok is required. The desktop app only needs outbound internet access.

Unlike the earlier one-shot prototype, messages are now routed into a **real DSH session**. That session uses whichever model is already selected in the session, and the GUI and the remote control share the same session state.

---

## Setup

### 1. Create a Feishu custom app

1. Go to [Feishu Open Platform](https://open.feishu.cn/).
2. Create an **enterprise self-built app** （企业自建应用）.
3. Enable **Bot** capability.
4. Grant these permissions:
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly` (for private chat)
   - `im:message.group_msg:readonly` (for group chat, optional)
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
| DSH session ID | Optional. Leave empty to create a new session on first use, or paste an existing session ID to share it with the GUI. |
| Turn wait timeout | `300000` (ms) — how long to wait for one DSH turn to finish. |
| Whitelist | Your Feishu `open_id` (one per line). |
| Feishu App ID | From step 1 |
| Feishu App Secret | From step 1 |
| Encrypt Key | Leave empty unless you enabled encryption in Feishu. |

Click **Save**.

### 4. Find your Feishu open_id

The easiest way is to send a message to the bot, then check EzDSH logs. The log line prints the sender's `open_id`. Add it to the whitelist and save again.

Alternatively, call Feishu's `contact/v3/users/me` API after logging in.

### 5. Send commands

In a Feishu group or private chat where the bot is present, send:

```
what is 2+2
```

The bot will forward the message to the configured DSH session and reply with the final answer (reasoning/thinking content is filtered out).

---

## Security

- Events are received over an outbound WebSocket to Feishu; no local port is exposed to the internet.
- Only Feishu user IDs in the whitelist can trigger commands.
- Commands run in the configured DSH session, sharing state with the GUI session.
- The credentials file is saved with mode `0o600`.

**Warning**: whitelisted users can execute anything the DSH session can do. Only add trusted users.

---

## Configuration file

The config is stored in EzDSH state directory as `channel-bridge.json`:

```json
{
  "enabled": true,
  "sessionId": "your-session-id",
  "sessionTimeoutMs": 300000,
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

- Session picker UI that lists existing DSH sessions instead of asking for an ID.
- Support for more platforms (WeChat, QQ, DingTalk) using the same adapter protocol.
