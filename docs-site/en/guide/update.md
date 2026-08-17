---
title: Download & Update
---

# Download & Update

## Downloading the installer

Download the installer for your platform from the GitHub Releases page:

| Platform | Installer |
|----------|-----------|
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.exe` installer |

Download from the release assets. Do **not** download the Artifacts from the GitHub Actions page — they are bundled into ZIPs for CI build archives and are not the installation entry point.

## Automatic updates

EzDSH checks for updates automatically in the background. When a new version is found, it prompts you, and you can update in-app after confirming.

### Will updating lose my data?

**No.** Updates only replace the client and the built-in AI runtime. They do not delete your:

- configuration
- sessions
- profiles
- plugins
- logs
- local work data

There's no need to reconfigure after an update — just keep using it.

## What if an update fails

If the update doesn't run automatically or fails:

1. Quit and reopen the app to trigger the update check again;
2. Make sure your network can reach the update service;
3. If it still fails, download the latest installer manually from GitHub Releases and install over the existing version (your user data is not affected).

## Related pages

- [Installation](./install)
- [First Run](./first-run)
- [FAQ](../faq)