<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-hero.png" alt="DenchClaw — AI CRM, hosted locally on your Mac. Built on OpenClaw." width="680" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/denchclaw"><img src="https://img.shields.io/npm/v/denchclaw?style=for-the-badge&color=000" alt="npm version"></a>&nbsp;
  <a href="https://discord.gg/PDFXNVQj9n"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://denchclaw.com">Website</a> · <a href="https://discord.gg/PDFXNVQj9n">Discord</a> · <a href="https://skills.sh">Skills Store</a> · <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a>
</p>

<br />

<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-app.png" alt="DenchClaw Web UI — workspace, object tables, and AI chat" width="780" />
  </a>
  <br />
  <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a> · <a href="https://discord.gg/PDFXNVQj9n">Join our Discord Server</a>
</p>

<br />

> **This is a fork of [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw)** maintained by [@daniel0tgc](https://github.com/daniel0tgc).
> See [Changes from upstream](#changes-from-upstream-denchclaw) for what's different.

---

## Changes from Upstream DenchClaw

This fork adds the following on top of the official [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw):

### macOS Sonoma (14+) Fix

macOS Sonoma sets a kernel-level `com.apple.provenance` attribute on files downloaded via npm. This causes `readFileSync` to fail with `EPERM: operation not permitted` on OpenClaw's bundled plugin files, preventing DenchClaw from starting on any macOS 14+ machine.

**Fix applied in `src/cli/bootstrap-external.ts`:**
- `--ignore-scripts` added to all `npm install openclaw` calls so the blocked postinstall does not abort the install
- `unblockOpenClawInstall()` rewrites each JS dist file via a `temp+rename` inode swap — content is fetched **in-memory** from the npm tarball (no disk write = no provenance) for files that are blocked
- The OpenClaw update flow now uses `npm install -g --ignore-scripts` + unblock instead of `openclaw update --yes`, so updates don't re-introduce the block

This fix is transparent on Linux and Windows (the unblock function is a no-op when files are already readable).

### Extensions

The `extensions/` directory contains custom OpenClaw plugins that are automatically loaded when you run this fork:

| Extension | Description |
|---|---|
| `dench-ai-gateway` | Dench Cloud AI model routing |
| `dench-identity` | Identity and auth helpers |
| `exa-search` | Web search via Exa |
| `posthog-analytics` | Analytics event tracking |
| `apollo-enrichment` | Contact/company data enrichment |

---

## Install (from this fork)

**Node 22+ and pnpm required.**

```bash
git clone https://github.com/daniel0tgc/denchclaw-extension.git
cd denchclaw-extension

pnpm install
pnpm build

# First time only — builds the web UI (~3 min)
pnpm web:build && pnpm web:prepack

# Run (opens at localhost:3100)
DENCH_API_KEY=your_key_from_dench.com/api pnpm dev
```

Get your Dench API key at **[dench.com/api](https://dench.com/api)**.

After the first-time build, subsequent runs are just:

```bash
DENCH_API_KEY=your_key pnpm dev
```

---

## AI Agent Setup Prompt

```
Install DenchClaw (an OpenClaw CRM Framwork) by running "npx denchclaw", when it asks to update OpenClaw, update it as DenchClaw requires up to date OpenClaw. When it asks for my Dench API Key, help me fetch it from dench.com/api and set it up. Remember that DenchClaw creates a new OpenClaw Gateway (~/.openclaw-dench) on port 19001 by default, and a new main agent in that gateway working in ~/.openclaw-dench/workspace directory (Separate from the usual non-DenchClaw OpenClaw gateway that usually sits in ~/.openclaw). All DenchClaw config sits in ~/.openclaw-dench/openclaw.json. Remember that anytime you interface with DenchClaw using openclaw commands, you must use "openclaw --profile dench" as a prefix, for example, to restart gateway, run "openclaw --profile dench gateway restart". After everything is setup, DenchClaw will be accessible at localhost:3100 by default. If for some reason that Port 19001 and 3100 or those ranges are taken, make sure to kill those ports/processes and then retry npx denchclaw. Also, sometimes if the Web UI on port 3100 crashes, just run "npx denchclaw update" to boot it back up. Remember to refer to https://github.com/DenchHQ/DenchClaw (DenchClaw's official GitHub Repository) for more information.
```

---

## Commands

```bash
pnpm dev                     # start DenchClaw (localhost:3100)
pnpm build                   # rebuild CLI after code changes
pnpm web:build               # rebuild web UI (run after web changes)
pnpm web:prepack             # finalize standalone web build

# OpenClaw gateway commands (always use --profile dench)
openclaw --profile dench gateway restart
openclaw --profile dench gateway status
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest

openclaw --profile dench config set gateway.port 19001
openclaw --profile dench gateway install --force --port 19001
openclaw --profile dench uninstall
```

### Daemonless / Docker

```bash
export DENCHCLAW_DAEMONLESS=1
openclaw --profile dench gateway --port 19001  # start gateway as foreground process
```

Or pass `--skip-daemon-install` per command:

```bash
pnpm dev --skip-daemon-install
```

---

## Troubleshooting

### `pairing required`

If the Control UI shows `gateway connect failed: pairing required`, list pending devices and approve:

```bash
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest
```

Then restart the web runtime:

```bash
npx denchclaw restart
```

### `EPERM: operation not permitted` on macOS

If you see this error on a non-macOS-Sonoma machine or after a system upgrade, the fix is already built into this fork's install flow. If it persists, try:

```bash
openclaw --profile dench gateway stop
openclaw --profile dench gateway install --force
openclaw --profile dench gateway restart
```

### Web UI not loading (`localhost:3100`)

```bash
npx denchclaw update   # re-boots the web runtime
```

---

## Development

```bash
git clone https://github.com/daniel0tgc/denchclaw-extension.git
cd denchclaw-extension

pnpm install
pnpm build

pnpm dev
```

Web UI development:

```bash
pnpm web:dev
```

Adding a new extension: create a folder under `extensions/` with an `openclaw.plugin.json` and a `package.json`. It will be picked up automatically on the next `pnpm install`.

---

## Upstream

This fork tracks [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw). To pull upstream changes:

```bash
git pull origin main   # origin points to DenchHQ/DenchClaw
```

The macOS fix is forward-compatible — it only touches `src/cli/bootstrap-external.ts` and does not conflict with upstream feature work.

---

## Open Source

MIT Licensed. Fork it, extend it, make it yours.

<p align="center">
  <a href="https://github.com/DenchHQ/DenchClaw"><img src="https://img.shields.io/github/stars/DenchHQ/DenchClaw?style=for-the-badge" alt="GitHub stars"></a>
</p>
