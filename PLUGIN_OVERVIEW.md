Automatically resume agent work that stopped only to ask for an unnecessary confirmation.

## How it works

After a BB thread becomes idle, Jev, Please Proceed sends the complete available top-level user and assistant text conversation to TypeSafe Jev and asks one binary question: should the agent continue because it is waiting for a rubber stamp or has paused before an obvious, already-authorized next step?

Only a `yes` probability above 95% triggers a continuation. The plugin rechecks that the thread is still idle and unchanged, then supplies the agent-only message `please proceed`. It never includes system prompts, tool traffic, attachments, nested-agent messages, or its own continuation messages in Jev's input.

## Guardrails

- Pending interactions and queued messages block automatic continuation.
- Every idle transition is deduplicated.
- An identical repeated stopping response is not continued twice.
- Jev calls time out after five seconds and are never retried.
- Only hashes and aggregate counters are stored; transcript text and raw Jev output are not retained.

The plugin requires a TypeSafe Jev API key and sends conversation text to TypeSafe's API. Aggregate behavior is available through `bb jev-please-proceed status`.
