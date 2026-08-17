---
title: First Run
---

# First Run

## What happens when you open the app

The first time you open EzDSH, the app automatically does the following:

1. Creates a local data directory on your machine;
2. Starts the built-in DeepSeek Harness runtime;
3. Runs a health check to confirm the runtime is ready;
4. Loads the Harness workspace.

No command line required — you don't need to manage ports or services manually.

## You see a web-like interface. What now?

What you see is the DeepSeek Harness Web UI (the workspace). If you haven't configured a model provider yet, the interface will prompt you to do so.

### 1. Choose a model provider

Pick a provider in the configuration, for example:

- **DeepSeek** (official, direct)
- **OpenAI**, **Anthropic**, **Google Gemini**
- **Moonshot / Kimi**, **Kimi Code**, **MiniMax**, **Z.AI / GLM**
- **Mistral**, **OpenRouter**, **Groq**, **Together AI**
- **Volcano Engine**

### 2. Enter your API key

Paste the API key you created on that provider's platform into the input field and save. If you don't have a key yet, see the [FAQ](../faq#what-is-an-api-key-and-where-do-i-get-one).

### 3. Start a session

Once configured, start a new session and ask away. Your sessions are saved locally and will still be there after you quit and reopen the app.

## Where is your data stored

EzDSH is local-first. API keys, sessions, profiles, plugins, and logs live in a local directory on your machine — nothing is uploaded to the cloud.

If you run into startup issues or a blank screen later, check the [troubleshooting section of the FAQ](../faq#troubleshooting), or open the runtime log from Settings to see what's wrong.