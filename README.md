# Jev, Please Proceed

Jev, Please Proceed watches BB threads for idle transitions and resumes work when Jev assigns more than 95% probability that the agent is merely waiting for a rubber stamp or has paused before an obvious, already-authorized next step.

## Install

```sh
bb plugin install git:https://github.com/lawrenceluk/bb-plugin-jev-please-proceed.git@^0.1.0
```

## Behavior

For each new `thread.idle` event, the plugin reads the complete available top-level conversation from BB's event history. It sends only user and assistant text to TypeSafe Jev; system prompts, tools, tool output, nested-agent messages, attachments, and the plugin's own agent-only continuation messages are excluded.

Jev answers one binary question. When `P(yes) > 0.95`, the plugin rechecks that the thread is still idle and unchanged, has no pending interaction, and has no queued message. It then sends the agent-only message `please proceed` with `mode: "start"`.

Each idle event is processed once. If `please proceed` produces the exact same final assistant response again, the plugin stops rather than looping.

The plugin sends conversation text to `https://api.typesafe.ai/v1/systemone` using model `jev-1.13.0`. Requests have a five-second timeout, no retry, and a 32 KiB response cap. The plugin stores only per-thread hashes and aggregate decision counters, never transcript text or raw Jev output.

## Configure

Install the plugin and set its secret `TypeSafe Jev API key` in BB's Installed plugins settings. Do not put the key in a command argument.

Inspect aggregate status without exposing the key or transcript:

```sh
bb jev-please-proceed status
bb jev-please-proceed status --json
```

## Develop

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
```

## License

MIT
