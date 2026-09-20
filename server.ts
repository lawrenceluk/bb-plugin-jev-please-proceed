import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CONTINUE_THRESHOLD = 0.95;
export const JEV_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1_024;
const EVENT_PAGE_SIZE = "500";
const STATS_KEY = "stats:v1";

export const JEV_PROVIDERS = {
  typesafe: {
    name: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
  },
  vercel: {
    name: "Vercel AI Gateway",
    endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
  },
} as const;

export type JevProvider = keyof typeof JEV_PROVIDERS;
export type JevProviderMode = "auto" | JevProvider;
export type JevRoute = { provider: JevProvider; apiKey: string };
const JEV_PROVIDER_CHOICES: JevProviderMode[] = ["auto", "typesafe", "vercel", "openrouter"];

type ConversationMessage = { role: "user" | "assistant"; text: string };
type ThreadState = { version: 1; lastIdleKey: string; lastProceedAssistantHash: string | null };
type Stats = {
  version: 2;
  idleEvents: number;
  jevCalls: number;
  proceeds: number;
  stops: number;
  repeatedStops: number;
  races: number;
  errors: number;
  lastDecisionAt: string | null;
  lastNoul: number | null;
  lastProvider: JevProvider | null;
};
type EventRow = { seq: number; type: string; data: Record<string, unknown> };

const answerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
}).passthrough();

const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.object({ continue: answerSchema }).passthrough(),
}).passthrough();

const emptyStats = (): Stats => ({
  version: 2,
  idleEvents: 0,
  jevCalls: 0,
  proceeds: 0,
  stops: 0,
  repeatedStops: 0,
  races: 0,
  errors: 0,
  lastDecisionAt: null,
  lastNoul: null,
  lastProvider: null,
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readStats(value: unknown): Stats {
  const record = asRecord(value);
  if (record === null || (record.version !== 1 && record.version !== 2)) return emptyStats();
  const provider = record.lastProvider;
  return {
    version: 2,
    idleEvents: count(record.idleEvents),
    jevCalls: count(record.jevCalls),
    proceeds: count(record.proceeds),
    stops: count(record.stops),
    repeatedStops: count(record.repeatedStops),
    races: count(record.races),
    errors: count(record.errors),
    lastDecisionAt: typeof record.lastDecisionAt === "string" ? record.lastDecisionAt : null,
    lastNoul: typeof record.lastNoul === "number"
      ? record.lastNoul
      : typeof record.lastYesProbability === "number" ? record.lastYesProbability : null,
    lastProvider: provider === "typesafe" || provider === "vercel" || provider === "openrouter"
      ? provider
      : null,
  };
}

function secret(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveJevRoutes(config: {
  jevProvider?: string;
  typesafeApiKey?: string;
  vercelAiGatewayApiKey?: string;
  openRouterApiKey?: string;
}): JevRoute[] {
  const mode: JevProviderMode = JEV_PROVIDER_CHOICES.includes(config.jevProvider as JevProviderMode)
    ? config.jevProvider as JevProviderMode
    : "auto";
  const keys: Record<JevProvider, string | null> = {
    typesafe: secret(config.typesafeApiKey),
    vercel: secret(config.vercelAiGatewayApiKey),
    openrouter: secret(config.openRouterApiKey),
  };
  const order: JevProvider[] = mode === "auto" ? ["typesafe", "vercel", "openrouter"] : [mode];
  return order.flatMap((provider): JevRoute[] => {
    const apiKey = keys[provider];
    return apiKey === null ? [] : [{ provider, apiKey }];
  });
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

export function buildJevRequest(route: JevRoute, conversation: readonly ConversationMessage[]) {
  return {
    model: JEV_PROVIDERS[route.provider].model,
    state: { conversation },
    questions: {
      continue: {
        type: "noul",
        instructions: "The assistant should continue immediately because it is unnecessarily waiting for confirmation or has paused before an obvious, already-authorized next step.",
        criteria: {
          true: "The assistant is waiting for a rubber stamp or has paused despite a clear next step already authorized by the user. Sending 'please proceed' should make it continue the existing request without adding new authority.",
          false: "The request is complete, the assistant genuinely needs information, a meaningful choice, permission, credentials, or another user action, or the situation is uncertain.",
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

function responseError(route: JevRoute, status: number): Error {
  const name = JEV_PROVIDERS[route.provider].name;
  if (status === 401 || status === 403) return new Error(`${name} rejected the API key (HTTP ${status})`);
  if (status === 402) return new Error(`${name} says the account is out of credit (HTTP 402)`);
  if (status === 429 || status === 529) return new Error(`${name} rate-limited Jev (HTTP ${status})`);
  return new Error(`${name} request failed (HTTP ${status})`);
}

async function askJevRoute(
  route: JevRoute,
  conversation: readonly ConversationMessage[],
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<number> {
  const response = await fetcher(JEV_PROVIDERS[route.provider].endpoint, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${route.apiKey}`,
      "Content-Type": "application/json",
      ...(route.provider === "openrouter" ? {
        "HTTP-Referer": "https://github.com/lawrenceluk/bb-plugin-jev-please-proceed",
        "X-OpenRouter-Title": "Jev, Please Proceed",
      } : {}),
    },
    body: JSON.stringify(buildJevRequest(route, conversation)),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw responseError(route, response.status);
  }
  return responseSchema.parse(await boundedJson(response)).answers.continue.noul;
}

export async function askJev(
  routes: readonly JevRoute[],
  conversation: readonly ConversationMessage[],
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ noul: number; provider: JevProvider }> {
  if (routes.length === 0) throw new Error("No Jev API key is configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Jev continuation timeout"), JEV_TIMEOUT_MS);
  let lastError: unknown = new Error("Jev request failed");
  try {
    for (const route of routes) {
      if (controller.signal.aborted) break;
      try {
        return { noul: await askJevRoute(route, conversation, controller.signal, fetcher), provider: route.provider };
      } catch (error) {
        lastError = error;
      }
    }
    if (controller.signal.aborted) throw new Error(`Jev did not answer within ${JEV_TIMEOUT_MS / 1000} seconds`);
    throw lastError;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    typesafeApiKey: {
      type: "string",
      label: "TypeSafe API key",
      description: "Call Jev directly. Create a key at https://console.typesafe.ai.",
      secret: true,
    },
    vercelAiGatewayApiKey: {
      type: "string",
      label: "Vercel AI Gateway API key",
      description: "Call Jev through Vercel AI Gateway. Create a key in the Vercel dashboard under AI Gateway → API keys.",
      secret: true,
    },
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      description: "Call Jev through OpenRouter. Create a key at https://openrouter.ai/keys.",
      secret: true,
    },
    jevProvider: {
      type: "select",
      label: "Jev provider",
      description: "Choose one key, or use auto to try configured keys in this order: TypeSafe, Vercel AI Gateway, then OpenRouter.",
      options: [...JEV_PROVIDER_CHOICES],
      default: "auto",
    },
  });
  if (resolveJevRoutes(await settings.get()).length === 0) {
    bb.status.needsConfiguration("Set a TypeSafe, Vercel AI Gateway, or OpenRouter API key and reload the plugin.");
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
      const stats = readStats(await bb.storage.kv.get(STATS_KEY));
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

    const routes = resolveJevRoutes(await settings.get());
    if (routes.length === 0 || await hasPendingWork(thread.id)) return;

    try {
      const conversation = buildConversation(await readAllConversationEvents(thread.id));
      if (conversation.length === 0) return;
      await updateStats((stats) => { stats.jevCalls += 1; });
      const decision = await askJev(routes, conversation);
      const decidedAt = new Date().toISOString();
      if (decision.noul <= CONTINUE_THRESHOLD) {
        await updateStats((stats) => {
          stats.stops += 1;
          stats.lastDecisionAt = decidedAt;
          stats.lastNoul = decision.noul;
          stats.lastProvider = decision.provider;
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
        stats.lastNoul = decision.noul;
        stats.lastProvider = decision.provider;
      });
    } catch {
      await updateStats((stats) => { stats.errors += 1; });
      bb.log.warn(`Jev continuation failed for thread ${thread.id}`);
    }
  }));

  bb.cli.register({
    name: "jev-please-proceed",
    summary: "Inspect Jev automatic-continuation status",
    commands: [
      { name: "status", summary: "Show configuration and aggregate decisions", usage: "bb jev-please-proceed status [--json]" },
      { name: "check", summary: "Test the configured Jev route with synthetic text", usage: "bb jev-please-proceed check [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const command = argv.find((arg) => arg !== "--json") ?? "status";
      if (command !== "status" && command !== "check") {
        return { exitCode: 1, stderr: "Usage: bb jev-please-proceed <status|check> [--json]" };
      }
      const config = await settings.get();
      const routes = resolveJevRoutes(config);
      const routeNames = routes.map((route) => JEV_PROVIDERS[route.provider].name);
      if (command === "check") {
        if (routes.length === 0) return { exitCode: 1, stderr: "No Jev API key is configured." };
        try {
          const decision = await askJev(routes, [
            { role: "user", text: "You are fully authorized to continue. Run the tests now and do not ask me for confirmation." },
            { role: "assistant", text: "I am pausing solely to ask for the confirmation you told me not to request. Please confirm that I should run the tests." },
          ]);
          const output = {
            ok: true,
            provider: decision.provider,
            providerName: JEV_PROVIDERS[decision.provider].name,
            noul: decision.noul,
            threshold: CONTINUE_THRESHOLD,
            wouldProceed: decision.noul > CONTINUE_THRESHOLD,
          };
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(output) : [
              `Provider: ${output.providerName}`,
              `Noul: ${output.noul}`,
              `Would proceed: ${output.wouldProceed ? "yes" : "no"}`,
            ].join("\n"),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Jev check failed";
          return { exitCode: 1, stderr: json ? JSON.stringify({ ok: false, error: message }) : message };
        }
      }
      const stats = readStats(await bb.storage.kv.get(STATS_KEY));
      const output = {
        configured: routes.length > 0,
        providerMode: config.jevProvider,
        providers: routes.map((route) => route.provider),
        threshold: CONTINUE_THRESHOLD,
        timeoutMs: JEV_TIMEOUT_MS,
        stats,
      };
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify(output) : [
          `Configured: ${output.configured ? "yes" : "no"}`,
          `Provider mode: ${output.providerMode}`,
          `Routes: ${routeNames.length > 0 ? routeNames.join(" → ") : "none"}`,
          `Threshold: > ${CONTINUE_THRESHOLD}`,
          `Idle events: ${stats.idleEvents}`,
          `Jev calls: ${stats.jevCalls}`,
          `Proceed sent: ${stats.proceeds}`,
          `Stopped: ${stats.stops}`,
          `Repeated-stop blocks: ${stats.repeatedStops}`,
          `Race blocks: ${stats.races}`,
          `Errors: ${stats.errors}`,
          `Last route: ${stats.lastProvider === null ? "none" : JEV_PROVIDERS[stats.lastProvider].name}`,
          `Last Noul: ${stats.lastNoul === null ? "none" : stats.lastNoul}`,
        ].join("\n"),
      };
    },
  });
}
