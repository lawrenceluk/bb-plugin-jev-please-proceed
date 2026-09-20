---
name: jev-please-proceed
description: "Inspect or troubleshoot Jev, Please Proceed, including automatic continuation decisions, provider routing, API-key setup, and the plugin's BB commands."
---

# Jev, Please Proceed

This plugin watches idle BB threads and sends the agent-only message `please proceed` only when TypeSafe Jev returns a Noul value above 0.95 for an unnecessary-confirmation judgment.

## Inspect it

Run `bb jev-please-proceed status` for configured routes and aggregate decisions. Add `--json` when machine-readable output helps.

Run `bb jev-please-proceed check` to test the configured provider route with synthetic text. This makes one small Jev request but sends no thread conversation.

## Configure it

The plugin accepts TypeSafe, Vercel AI Gateway, and OpenRouter keys. Keys are secret BB plugin settings; never ask the user to paste one into chat or put one in a shell command. Direct the user to **Settings → Installed plugins → Jev, Please Proceed**, then reload with `bb plugin reload jev-please-proceed` after a setting changes.

`auto` tries configured routes in this order: TypeSafe, Vercel AI Gateway, OpenRouter. A pinned provider uses only its matching key.

## Operating constraints

Every provider attempt shares one five-second timeout, and no route is retried. The plugin excludes system prompts, tool traffic, attachments, nested-agent messages, and its own continuation messages from Jev input. It stores hashes and aggregate counters, not transcript text or raw Jev output.
