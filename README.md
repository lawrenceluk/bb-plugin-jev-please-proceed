# Jev, Please Proceed

Jev, Please Proceed watches BB threads for idle transitions and resumes work when Jev assigns a Noul value above 0.95 to the judgment that the agent is merely waiting for a rubber stamp or has paused before an obvious, already-authorized next step.

## Install

```sh
bb plugin install git:https://github.com/lawrenceluk/bb-plugin-jev-please-proceed.git@^0.1.0
```

## Behavior

For each new `thread.idle` event, the plugin reads the complete available top-level conversation from BB's event history. It sends only user and assistant text to TypeSafe Jev; system prompts, tools, tool output, nested-agent messages, attachments, and the plugin's own agent-only continuation messages are excluded.

Jev answers one Noul question, which returns the probability that the judgment is true. When `noul > 0.95`, the plugin rechecks that the thread is still idle and unchanged, has no pending interaction, and has no queued message. It then sends the agent-only message `please proceed` with `mode: "start"`.

Each idle event is processed once. If `please proceed` produces the exact same final assistant response again, the plugin stops rather than looping.

The plugin can call Jev directly through TypeSafe, through Vercel AI Gateway, or through OpenRouter. In `auto` mode it tries whichever configured keys are available in that order, falling back only when a route fails. All routes share one five-second overall timeout, no route is retried, and responses have a 32 KiB cap. The plugin stores only per-thread hashes and aggregate decision counters, never transcript text or raw Jev output.

## Configure

Install the plugin and set at least one secret key in BB's Installed plugins settings: `TypeSafe API key`, `Vercel AI Gateway API key`, or `OpenRouter API key`. Keep `Jev provider` on `auto` to use any configured key with fallback, or pin one provider. Do not put a key in a command argument.

Test the configured route with synthetic text before relying on it:

```sh
bb jev-please-proceed check
bb jev-please-proceed check --json
```

Inspect aggregate status without exposing the key or transcript:

```sh
bb jev-please-proceed status
bb jev-please-proceed status --json
```

When a real thread becomes idle, its top-level user and assistant conversation text is sent to the selected provider and processed by TypeSafe Jev. TypeSafe, Vercel AI Gateway, or OpenRouter usage charges and account limits may apply.

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
