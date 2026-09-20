import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.13.0";
export const CONTINUE_THRESHOLD = 0.95;
export const JEV_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1_024;
const EVENT_PAGE_SIZE = "500";
const STATS_KEY = "stats:v1";

type ConversationMessage = { role: "user" | "assistant"; text: string };
type ThreadState = { version: 1; lastIdleKey: string; lastProceedAssistantHash: string | null };
type Stats = {
  version: 1;
  idleEvents: number;
  jevCalls: number;
  proceeds: number;
  stops: number;
  repeatedStops: number;
  races: number;
  errors: number;
  lastDecisionAt: string | null;
  lastYesProbability: number | null;
};
type EventRow = { seq: number; type: string; data: Record<string, unknown> };

const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.enum(["yes", "no"]),
  probabilities: z.object({ yes: z.number().min(0).max(1), no: z.number().min(0).max(1) }).strict()
    .refine(({ yes, no }) => Math.abs(yes + no - 1) <= 0.01, "probabilities must sum to one"),
  confidence: z.number().min(0).max(1),
}).strict();

const responseSchema = z.object({
  model: z.literal(TYPESAFE_MODEL),
  answers: z.object({ continue: answerSchema }).strict(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(),
}).strict();

const emptyStats = (): Stats => ({
  version: 1,
  idleEvents: 0,
  jevCalls: 0,
  proceeds: 0,
  stops: 0,
  repeatedStops: 0,
  races: 0,
  errors: 0,
  lastDecisionAt: null,
  lastYesProbability: null,
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textFromBlocks(value: unknown, visibleOnly: boolean): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const record = asRecord(block);
    if (record?.type !== "text" || typeof record.text !== "string") return [];
    if (visibleOnly && record.visibility === "agent-only") return [];
    return [record.text];
  }).join("\n").trim();
}

/** Build the complete top-level visible user/assistant transcript from raw BB events. */
export function buildConversation(events: readonly EventRow[]): ConversationMessage[] {
  const visibleRequestText = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "client/turn/requested") continue;
    const requestId = event.data.requestId;
    if (typeof requestId !== "string") continue;
    const direct = textFromBlocks(event.data.input, true);
    const groups = Array.isArray(event.data.inputGroups)
      ? event.data.inputGroups.map((group) => textFromBlocks(group, true)).filter(Boolean).join("\n")
      : "";
    visibleRequestText.set(requestId, [direct, groups].filter(Boolean).join("\n"));
  }

  const conversation: ConversationMessage[] = [];
  for (const event of events) {
    if (event.type !== "item/completed") continue;
    const item = asRecord(event.data.item);
    if (item === null || item.parentToolCallId !== undefined) continue;
    if (item.type === "userMessage") {
      const clientRequestId = item.clientRequestId;
      const mapped = typeof clientRequestId === "string" ? visibleRequestText.get(clientRequestId) : undefined;
      if (mapped === "") continue;
      const text = mapped ?? textFromBlocks(item.content, false);
      if (text) conversation.push({ role: "user", text });
    } else if (item.type === "agentMessage" && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) conversation.push({ role: "assistant", text });
    }
  }
  return conversation;
}

export function buildJevRequest(conversation: readonly ConversationMessage[]) {
  return {
    model: TYPESAFE_MODEL,
    state: JSON.stringify({ conversation }),
    questions: {
      continue: {
        type: "choice",
        instructions: "Should the assistant continue immediately because it is unnecessarily waiting for confirmation or has an obvious, already-authorized next step?",
        criteria: {
          yes: "The assistant is waiting for a rubber stamp or has paused despite a clear next step already authorized by the user. Sending 'please proceed' should make it continue the existing request without adding new authority.",
          no: "The request is complete, the assistant genuinely needs information, a meaningful choice, permission, credentials, or another user action, or the situation is uncertain.",
        },
      },
    },
  } as const;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("TypeSafe response exceeded byte cap");
  if (response.body === null) throw new Error("TypeSafe response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("TypeSafe response exceeded byte cap");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"));
}

export async function askJev(apiKey: string, conversation: readonly ConversationMessage[], fetcher: typeof fetch = globalThis.fetch): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Jev continuation timeout"), JEV_TIMEOUT_MS);
  try {
    const response = await fetcher(TYPESAFE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildJevRequest(conversation)),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("TypeSafe request failed");
    }
    return responseSchema.parse(await boundedJson(response)).answers.continue.probabilities.yes;
  } catch {
    throw new Error("TypeSafe Jev request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    typesafeApiKey: { type: "string", label: "TypeSafe Jev API key", secret: true },
  });
  if (!(await settings.get()).typesafeApiKey) {
    bb.status.needsConfiguration("Set the TypeSafe Jev API key to enable automatic continuation.");
  }

  const locks = new Map<string, Promise<void>>();
  let statsLock = Promise.resolve();

  function serialized(threadId: string, work: () => Promise<void>): Promise<void> {
    const prior = locks.get(threadId) ?? Promise.resolve();
    const run = prior.then(work, work);
    const tracked = run.catch(() => undefined);
    locks.set(threadId, tracked);
    return run.finally(() => {
      if (locks.get(threadId) === tracked) locks.delete(threadId);
    });
  }

  async function updateStats(patch: (stats: Stats) => void): Promise<void> {
    const run = statsLock.then(async () => {
      const current = await bb.storage.kv.get<Stats>(STATS_KEY);
      const stats = current?.version === 1 ? current : emptyStats();
      patch(stats);
      await bb.storage.kv.set(STATS_KEY, stats);
    });
    statsLock = run.catch(() => undefined);
    await run;
  }

  async function readAllConversationEvents(threadId: string): Promise<EventRow[]> {
    const all: EventRow[] = [];
    let afterSeq: string | undefined;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        order: "asc",
        limit: EVENT_PAGE_SIZE,
        types: ["client/turn/requested", "item/completed"],
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      if (page.length === 0) return all;
      all.push(...page as EventRow[]);
      const next = String(page.at(-1)!.seq);
      if (next === afterSeq) throw new Error("Thread event pagination did not advance");
      afterSeq = next;
    }
  }

  async function hasPendingWork(threadId: string): Promise<boolean> {
    const [interactions, queued] = await Promise.all([
      bb.sdk.threads.interactions.list({ threadId }),
      bb.sdk.threads.queuedMessages.list({ threadId }),
    ]);
    return interactions.some((interaction) => interaction.status === "pending" || interaction.status === "resolving") || queued.length > 0;
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => serialized(thread.id, async () => {
    await updateStats((stats) => { stats.idleEvents += 1; });
    if (thread.archivedAt !== null || thread.deletedAt !== null || !lastAssistantText?.trim()) return;

    const assistantHash = hash(lastAssistantText.trim());
    const idleKey = hash(`${thread.updatedAt}\0${assistantHash}`);
    const stateKey = `thread:${thread.id}`;
    const previous = await bb.storage.kv.get<ThreadState>(stateKey);
    if (previous?.version === 1 && previous.lastIdleKey === idleKey) return;

    const state: ThreadState = {
      version: 1,
      lastIdleKey: idleKey,
      lastProceedAssistantHash: previous?.version === 1 ? previous.lastProceedAssistantHash : null,
    };
    await bb.storage.kv.set(stateKey, state);

    if (state.lastProceedAssistantHash === assistantHash) {
      await updateStats((stats) => { stats.repeatedStops += 1; });
      return;
    }

    const { typesafeApiKey } = await settings.get();
    if (!typesafeApiKey || await hasPendingWork(thread.id)) return;

    try {
      const conversation = buildConversation(await readAllConversationEvents(thread.id));
      if (conversation.length === 0) return;
      await updateStats((stats) => { stats.jevCalls += 1; });
      const yesProbability = await askJev(typesafeApiKey, conversation);
      const decidedAt = new Date().toISOString();
      if (yesProbability <= CONTINUE_THRESHOLD) {
        await updateStats((stats) => {
          stats.stops += 1;
          stats.lastDecisionAt = decidedAt;
          stats.lastYesProbability = yesProbability;
        });
        return;
      }

      const current = await bb.sdk.threads.get({ threadId: thread.id });
      if (current.status !== "idle" || current.updatedAt !== thread.updatedAt || current.archivedAt !== null || current.deletedAt !== null || await hasPendingWork(thread.id)) {
        await updateStats((stats) => { stats.races += 1; });
        return;
      }

      await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "start",
        input: [{ type: "text", text: "please proceed", mentions: [], visibility: "agent-only" }],
      });
      state.lastProceedAssistantHash = assistantHash;
      await bb.storage.kv.set(stateKey, state);
      await updateStats((stats) => {
        stats.proceeds += 1;
        stats.lastDecisionAt = decidedAt;
        stats.lastYesProbability = yesProbability;
      });
    } catch {
      await updateStats((stats) => { stats.errors += 1; });
      bb.log.warn(`Jev continuation failed for thread ${thread.id}`);
    }
  }));

  bb.cli.register({
    name: "jev-please-proceed",
    summary: "Inspect Jev automatic-continuation status",
    commands: [{ name: "status", summary: "Show aggregate decisions", usage: "bb jev-please-proceed status [--json]" }],
    async run(argv) {
      const json = argv.includes("--json");
      const command = argv.find((arg) => arg !== "--json") ?? "status";
      if (command !== "status") return { exitCode: 1, stderr: "Usage: bb jev-please-proceed status [--json]" };
      const stats = (await bb.storage.kv.get<Stats>(STATS_KEY)) ?? emptyStats();
      const configured = Boolean((await settings.get()).typesafeApiKey);
      const output = { configured, threshold: CONTINUE_THRESHOLD, timeoutMs: JEV_TIMEOUT_MS, stats };
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify(output) : [
          `Configured: ${configured ? "yes" : "no"}`,
          `Threshold: > ${CONTINUE_THRESHOLD}`,
          `Idle events: ${stats.idleEvents}`,
          `Jev calls: ${stats.jevCalls}`,
          `Proceed sent: ${stats.proceeds}`,
          `Stopped: ${stats.stops}`,
          `Repeated-stop blocks: ${stats.repeatedStops}`,
          `Race blocks: ${stats.races}`,
          `Errors: ${stats.errors}`,
        ].join("\n"),
      };
    },
  });
}
