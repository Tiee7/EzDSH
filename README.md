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
  <a href="#local-use">Local Use</a> •
  <a href="#build-from-source">Build from Source</a> •
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

## Local use

### Option A: Use the installed app

These steps are for users who only want to use EzDSH. You do not need Node.js, pnpm, or a terminal.

1. Open the [Releases](../../releases) page.
2. Download the installer for your platform:
   - macOS Apple Silicon: `.dmg`
   - Windows x64: `.exe`

   Download these files from the release asset list. GitHub Actions' `Artifacts` are build archives wrapped in ZIP format and are intended for CI inspection, not normal installation.
3. Install EzDSH:
   - On macOS, open the `.dmg` and drag `EzDSH.app` to `Applications`.
   - On Windows, run the `.exe` installer and follow the prompts.
4. Open EzDSH from `Applications` or the Start menu.
5. Configure your model provider in the Harness Web UI.
6. Start working. EzDSH launches the Runtime and opens the Harness workspace automatically.

### Option B: Run from source

These steps are for developers who want to run the project locally from a source checkout. This is different from building an installer.

1. Install Node.js `24.18.0` (or a version accepted by `package.json`).
2. Open a terminal and enter the project directory:

   ```bash
   cd /Users/snake/Documents/ChatGPT/ezdsh
   ```

3. Install project dependencies. Run this once after cloning, or whenever dependencies change:

   ```bash
   npm ci
   ```

4. Start the local development app:

   ```bash
   npm run dev
   ```

5. Use the Harness Web UI opened by EzDSH. Press `Ctrl+C` in the terminal to stop the development app.

## Build from source

### macOS (Apple Silicon)

These steps are for developers who need to create a distributable installer or release package.

1. Use a macOS Apple Silicon machine and install Node.js `24.18.0` (or a version accepted by `package.json`).
2. Open a terminal and enter the project directory:

   ```bash
   cd /Users/snake/Documents/ChatGPT/ezdsh
   ```

3. Install project dependencies:

```bash
npm ci
```

4. Create the signed release packages:

```bash
npm run package:mac:release
```

This builds the bundled DSH Runtime, creates a signed DMG and ZIP, and verifies the packaged Runtime. A valid `Developer ID Application` certificate is required. The artifacts are written to `dist/`.

For a local unsigned ZIP used only for testing updates, run instead:

```bash
npm run package:mac:zip
```

5. To install the DMG, open it and drag `EzDSH.app` into `Applications`. Opening `dist/mac-arm64/EzDSH.app` directly is useful for local development, but does not test the DMG installation or Gatekeeper flow.

### Windows (x64)

1. Use a native Windows x64 machine and install Node.js `24.18.0`.
2. Open PowerShell and enter the project directory:

   ```powershell
   cd C:\path\to\ezdsh
   ```

3. Install project dependencies:

```powershell
npm ci
```

4. Create the Windows installer:

```powershell
npm run package:win
```

This stages the Windows Node Runtime, builds the DSH Runtime with Windows-native dependencies, creates an NSIS installer, and verifies the unpacked bundle. The installer is written to `dist/`.

5. For a signed release build, configure a Windows code-signing certificate and run:

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

For normal installation, download the `.dmg` or `.exe` directly from a GitHub Release. The macOS `.zip` is retained for the automatic update channel and is not the primary installer.

## License

EzDSH is released under the [MIT License](./LICENSE).

---

<p align="center">
  <sub>Built for the DeepSeek Harness community.</sub>
</p>
