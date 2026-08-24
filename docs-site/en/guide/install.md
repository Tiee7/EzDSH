---
title: Installation
---

# Installation

## Supported platforms

EzDSH currently supports the following platforms:

| Platform | Installer |
|----------|-----------|
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.exe` installer |

> Windows ARM64 is not supported yet.

## Do I need to install anything else first

**No.** EzDSH bundles a fixed version of the DeepSeek Harness runtime, so you don't need to install Node.js, pnpm, or the DSH CLI beforehand. Install and use it directly.

## Where to download

1. Open the GitHub Releases page;
2. Download the installer for your platform from the release assets:
   - macOS (Apple Silicon): `.dmg`
   - Windows (x64): `.exe`

::: warning Note
Do not download the **Artifacts** from the GitHub Actions page — they are bundled into ZIPs for CI build archives and are not the installation entry point for end users.
:::

## macOS installation

1. Open the downloaded `.dmg` file;
2. Drag `EzDSH.app` into the "Applications" folder;
3. Open EzDSH from "Applications" or Launchpad.

If macOS warns "cannot verify the developer" on first open:

- Right-click `EzDSH.app` → choose "Open", then confirm in the dialog;
- Or go to System Settings → Privacy & Security and allow it under "Open Anyway".

## Windows installation

The Windows installer is not code-signed yet, so Windows will show a security warning. Click **More info** and then **Run anyway** to proceed.

1. Run the downloaded `.exe` installer;

   ![Windows installation step 1](/en/1.png)

2. When the "Windows protected your PC" prompt appears, click **More info**;

   ![Windows installation step 2](/en/2.png)

3. Click **Run anyway** to continue the installation;

   ![Windows installation step 3](/en/3.png)

4. Follow the setup wizard to complete the installation;

   ![Windows installation step 4](/en/4.png)

5. Choose the installation directory, recommended on the D: drive.

   ![Windows installation step 5](/en/5.png)

## After installation

Open EzDSH and it will automatically start the built-in AI runtime and load the workspace. Next, follow [First Run](./first-run) to configure a provider, or check the [FAQ](../faq).