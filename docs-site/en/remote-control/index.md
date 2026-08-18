---
title: Remote Control
---

# Remote Control

Remote control lets you send commands to DSH through messaging platforms. The first supported platform is **Feishu**, shown as "Feishu control" in settings.

## How it works

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

Long-running tasks run **asynchronously**:

1. Send a command from Feishu;
2. The bot immediately replies "Task received, running in the DSH session.";
3. While the turn is running, the bot sends a progress update at the configured interval (e.g. every 60 seconds);
4. When the turn finishes, the bot sends the final answer (reasoning/thinking blocks are filtered out);
5. Only one command per session can run at a time; new messages are rejected until the current turn ends.

## Setup

### 1. Create a Feishu custom app

1. Go to [Feishu Open Platform](https://open.feishu.cn/);
2. Create an **enterprise self-built app**;
3. Enable **Bot** capability;
4. Grant these permissions:
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly` (for private chat)
   - `im:message.group_msg:readonly` (for group chat, optional)
5. Publish the app to your tenant;
6. Copy the **App ID** and **App Secret**.

### 2. Configure the Feishu event subscription

In the Feishu app console:

1. Go to **Event Subscriptions**;
2. Choose **Use long connection to receive events**;
3. Add this event type:
   - `im.message.receive_v1`
4. Save.

No request URL, ngrok, or firewall rule is required.

### 3. Configure EzDSH

Open EzDSH → **Settings → Feishu control**.

| Field | Value |
|---|---|
| Enable Feishu control | On |
| DSH session ID | Optional. Leave empty to create a new session on first use, or paste an existing session ID to share it with the GUI. |
| Turn wait timeout (ms) | `300000` — maximum time to wait for one DSH turn. |
| Status update interval (ms) | `60000` — how often to send a progress update while the turn is running. |
| Whitelisted user Open IDs (one per line) | Your Feishu `open_id`. |
| App ID | From step 1 |
| App Secret | From step 1 |

Click **Save**.

### 4. Pair your Feishu account

Instead of manually finding your `open_id`, use the verification-code pairing:

1. In EzDSH, go to **Settings → Feishu control**;
2. Fill in the Feishu **App ID** and **App Secret**;
3. Click **Start pairing**;
4. EzDSH shows a 6-digit code and starts a 5-minute timer;
5. Send that code to the Feishu bot in a private chat;
6. EzDSH automatically adds your `open_id` to the allowlist and replies "Pairing successful. Your Open ID has been added to the allowlist.".

Only private chat messages can complete pairing, and the code expires after 5 minutes.

### 5. Send commands

In a Feishu group or private chat where the bot is present, send:

```
what is 2+2
```

The bot will immediately acknowledge the task, execute it in the configured DSH session, and reply with the final answer once the turn completes. Progress updates are sent periodically based on the **Status update interval** setting.

## Security

- Events are received over an outbound WebSocket to Feishu; no local port is exposed to the internet;
- Only Feishu user IDs in the allowlist can trigger commands;
- Commands run in the configured DSH session, sharing state with the GUI session;
- The credentials file is saved with mode `0o600`.

::: warning Note
Whitelisted users can execute anything the DSH session can do. Only add trusted users.
:::

## Configuration file

The config is stored in the EzDSH data directory as `channel-bridge.json`:

```json
{
  "enabled": true,
  "sessionId": "your-session-id",
  "sessionTimeoutMs": 300000,
  "statusIntervalMs": 60000,
  "allowList": ["ou_xxxxxxxx"],
  "timeoutMs": 120000,
  "feishu": {
    "appId": "cli_xxxxxxxx",
    "appSecret": "xxxxxxxx"
  }
}
```

## Future work

- Support for more platforms (WeChat, QQ, DingTalk) using the same adapter protocol;
- Cancel a running turn from Feishu.
