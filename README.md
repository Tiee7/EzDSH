# EzDSH

<p align="center">
  <img src="logo.png" alt="EzDSH" width="128" />
</p>

<p align="center">
  <strong>The truly out-of-the-box DeepSeek Harness desktop workspace.</strong><br/>
  Turn DeepSeek Harness from a developer tool into a ready-to-use local AI agent platform.
</p>

<p align="center">
  <a href="#why-ezdsh">Why EzDSH</a> •
  <a href="#download">Download</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="README.zh-CN.md">中文版</a>
</p>

---

## Why EzDSH

DeepSeek Harness is powerful, but getting it running locally means installing runtimes, starting services from the terminal, managing ports, editing provider configs, and keeping processes alive. EzDSH wraps all of that into a single desktop app so you can focus on building with AI instead of fighting your environment.

> **EzDSH makes DeepSeek Harness feel like a finished product, not a setup tutorial.**

## What you get

### Install and run, no environment setup

EzDSH ships with a fixed-version DeepSeek Harness Runtime. You do not need to install Node.js, pnpm, or the Harness CLI yourself. The app creates the workspace, picks a local port, starts the runtime, and loads the Harness Web UI automatically.

### Full runtime lifecycle management

EzDSH is not a browser wrapper. It manages the complete Runtime lifecycle:

- Automatic startup and graceful shutdown
- Health checks and readiness detection
- Port conflict detection and retry
- Startup timeout handling
- Crash recovery and restart
- Runtime log collection and viewing
- No orphaned background processes

You see a stable desktop app, not a collection of terminal windows.

### DSH-native configuration

EzDSH starts the DSH Runtime directly and leaves provider configuration to the Harness Web UI. EzDSH's own provider setup page is currently hidden so the first release can focus on reliable startup and packaging; the desktop configuration flow will be added in a later version.

### Local-first and security-minded

Your keys, sessions, profiles, plugins, and logs stay on your machine.

- API keys never enter renderer storage
- API keys never appear in ordinary logs
- Credentials are saved with restricted permissions
- Renderer is isolated from the file system and Node.js APIs
- Runtime only listens on `127.0.0.1`

EzDSH is built for users who want to keep their model calls and work data under their own control.

### Upgrades that respect your data

App code, Runtime, and user data are kept separate. Updating EzDSH replaces the client and runtime without touching your:

- Configuration
- Sessions
- Profiles
- Plugins
- Logs
- Local workspace data

You do not rebuild your environment every time the app updates.

### A polished front door for Harness

DeepSeek Harness handles the agent runtime, model calls, tool execution, and Web UI. EzDSH adds the product layer it needs:

- Installer and first-run onboarding
- Visual provider and profile management
- Process supervision and error recovery
- Local data and log management
- Built-in update delivery
- Security boundaries

Harness provides the engine. EzDSH provides the experience.

## Who it is for

- Developers who want to run DeepSeek Harness locally
- AI users who prefer not to live in the terminal
- Users who switch between multiple model providers
- Anyone who wants API keys and project data kept local
- Professionals who need a stable desktop entry point for agent, tool, and plugin workflows

## Quick start

1. **Download** the installer for macOS or Windows from the [Releases](../../releases) page.
2. **Install and open** EzDSH.
3. **Configure your provider** in the Harness Web UI.
4. **Start working.** EzDSH launches the Runtime and opens the Harness workspace automatically.

## Build and install

### macOS (Apple Silicon)

The current release target is macOS arm64. Use Node.js `24.18.0` (or another version accepted by `package.json`) and run from the repository root:

```bash
npm ci
npm run package:mac:release
```

`package:mac:release` builds the bundled DSH Runtime, creates a signed DMG and ZIP, and verifies the packaged Runtime. A valid `Developer ID Application` certificate is required for release builds. For a local unsigned ZIP used only for testing updates, use:

```bash
npm run package:mac:zip
```

The artifacts are written to `dist/`. To install the DMG, open it and drag `EzDSH.app` into `Applications`. Opening `dist/mac-arm64/EzDSH.app` directly is useful for local development, but does not test the DMG installation or Gatekeeper flow.

### Windows (x64)

Build on a native Windows x64 machine with Node.js `24.18.0` and the repository checkout:

```powershell
npm ci
npm run package:win
```

The command stages the Windows Node Runtime, builds the DSH Runtime with Windows-native dependencies, creates an NSIS installer, and verifies the unpacked bundle. The installer is written to `dist/` and can be run directly on Windows. For a signed release build, configure a Windows code-signing certificate and use:

```powershell
npm run package:win:release
```

Windows packaging is prepared for x64 only. It is not executed on the current macOS development machine.

## Download

| Platform | Package |
|----------|---------|
| macOS (Apple Silicon) | `.dmg` / `.zip` |
| Windows | `.exe` installer |

EzDSH checks for updates automatically and notifies you when a new release is available.

## License

EzDSH is released under the [MIT License](./LICENSE).

---

<p align="center">
  <sub>Built for the DeepSeek Harness community.</sub>
</p>
