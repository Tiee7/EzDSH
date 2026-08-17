---
title: FAQ
---

# FAQ

## Basics

### Do I have to configure an API key to use EzDSH?

To actually use the AI features, you need to configure an API key for at least one model provider. Without a key the app opens normally, but you can't call models and the interface will prompt you to configure a provider.

An API key is the credential used to call a model service (e.g., DeepSeek). A typical first-run flow is:

1. Open EzDSH and enter the Harness workspace;
2. Choose a model provider as prompted;
3. Enter that provider's API key;
4. Start your first session.

### What is an API key, and where do I get one?

An API key is a private credential string issued by a model provider — think of it as the "key" to call models. The provider uses it to identify your account and bill you for usage.

To get one, register on the provider's developer platform and create an API key. For example:

- **DeepSeek**: sign up and create an API key at [platform.deepseek.com](https://platform.deepseek.com);
- Other providers: create a key on their respective developer platforms.

EzDSH is not tied to a single provider. It supports DeepSeek, OpenAI, Anthropic, Google Gemini, Moonshot/Kimi, Kimi Code, MiniMax, Z.AI/GLM, Mistral, OpenRouter, Groq, Together AI, Volcano Engine, and more. A key only works with the provider that issued it.

### What is EzDSH, and what can I do with it?

EzDSH is a desktop client for DeepSeek Harness. It wraps DeepSeek Harness (a local AI workspace) into an install-and-run desktop app: install it, open it, and it automatically starts the AI runtime on your own machine and loads the workspace — no Node.js install and no command line required.

You can chat with AI and let it handle tasks such as writing code, running commands, or analyzing files. DeepSeek Harness provides the AI capabilities; EzDSH gives you a stable, easy-to-use desktop entry point.

### What's the difference between EzDSH and the DeepSeek web/app?

- **DeepSeek web/app** is a cloud service: your conversations live on the cloud and you can only use DeepSeek's own models.
- **EzDSH** is a local desktop app: the AI runtime runs on your own machine, sessions and data stay local, and you're not limited to DeepSeek — you can configure multiple model providers and switch between them.

In short, the web/app sends your data to the cloud; EzDSH puts AI on your machine and keeps your data under your control.

## First Run

### I see a web-like interface after opening the app. What should I do?

What you see is the DeepSeek Harness Web UI (the workspace). If you haven't configured a provider yet, it will prompt you to do so: follow the prompts to pick a provider, enter the API key, then start a new session and ask away.

There's no need to save manually — your sessions are stored locally automatically and will still be there after you quit and reopen the app.

### How do I choose a provider and enter my API key?

In the Harness workspace configuration, choose a provider (e.g., DeepSeek, OpenAI, Kimi), paste the API key you created on that provider's platform, and save. Once configured, you can use models under that provider.

In the current version, provider configuration is handled by the DeepSeek Harness Web UI; EzDSH starts the runtime using that configuration.

### Will I lose my conversations if I close the app?

No. EzDSH is local-first: your sessions, configuration, profiles, plugins, and logs are stored in a local directory on your machine. Closing the app only stops the runtime process — nothing is deleted, and everything is restored when you open it again.

## Security / Privacy

### Can my API key be uploaded or leaked?

No. Your API key is stored only in a local credentials file on your machine, written with restricted permissions. It never goes into browser storage, never appears in normal logs, and is never sent to any cloud backend — it's only used to communicate with the model provider you chose.

### Where is my conversation data stored? Is it synced to the cloud?

It's stored on your machine. Sessions and project data live in the app's local data directory, with no cloud backend and no cloud sync. Upgrading the app does not remove this data.

### Why does this software only run locally?

That's the local-first design goal. Both the DeepSeek Harness AI runtime and your data run and live on your own machine. The runtime only listens on the local address `127.0.0.1`, so external networks can't reach it directly. Your model calls, API key, and project data stay under your control.

## Troubleshooting

### What should I do if the app shows a blank screen or keeps loading?

A blank screen or endless spinner usually means the local AI runtime isn't ready yet. Try:

1. Wait a few seconds for it to finish its startup check;
2. Quit and reopen the app;
3. Check the runtime log to see where startup is stuck;
4. Make sure no other program is occupying the port.

If it keeps failing, check the logs and report the issue.

### What should I do if startup fails or the health check fails?

After EzDSH starts the DeepSeek Harness runtime, it performs a health check within about 30 seconds and reports the reason on failure. Common causes and fixes:

- **Port already in use**: the app detects and retries automatically; if it still fails after many retries, close the conflicting program and restart the app;
- **Startup timeout**: close resource-heavy programs and retry, or restart your computer;
- **Data directory permission issue**: make sure your user has read/write access to the app's data directory.

If it still fails, open the log to see the exact error and report it together with the log.

### Where can I view logs and error messages?

Open the app settings and click the "Open Log" button (Settings → Runtime → Open Log); it will open the log file with your system's default app.

You can also find the log file manually:

- **macOS**: `~/Library/Application Support/EzDSH/logs/harness.log`
- **Windows**: `%APPDATA%\EzDSH\logs\harness.log`

Including the log content when reporting issues is very helpful.

## Update / Uninstall

### How do I update? Will updating lose my data?

EzDSH checks for updates automatically and prompts you when a new version is available; you can update in-app after confirming.

Updates only replace the client and the AI runtime — they do **not** delete your configuration, sessions, profiles, plugins, logs, or local work data. There's no need to reconfigure after an update.

### How do I uninstall? Will my data be kept?

To uninstall:

- **macOS**: move EzDSH from "Applications" to the Trash;
- **Windows**: uninstall from Settings → Apps, or run the installer and choose uninstall.

Uninstalling removes the app itself, but your local data directory (configuration, sessions, logs, etc.) is kept by default; to remove everything, delete the data directory manually.
