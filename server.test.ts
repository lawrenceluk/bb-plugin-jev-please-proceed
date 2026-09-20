import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { buildConversation, buildJevRequest, CONTINUE_THRESHOLD, TYPESAFE_MODEL } from "./server.js";

type TestEvent = { seq: number; type: string; data: Record<string, unknown> };

function userItem(seq: number, text: string, clientRequestId?: string): TestEvent {
  return {
    seq,
    type: "item/completed",
    data: {
      item: {
        id: `user-${seq}`,
        type: "userMessage",
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
        content: [{ type: "text", text }],
      },
    },
  };
}

function assistantItem(seq: number, text: string, parentToolCallId?: string): TestEvent {
  return {
    seq,
    type: "item/completed",
    data: {
      item: {
        id: `assistant-${seq}`,
        type: "agentMessage",
        text,
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      },
    },
  };
}

function turnRequest(seq: number, requestId: string, text: string, agentOnly = false): TestEvent {
  return {
    seq,
    type: "client/turn/requested",
    data: {
      requestId,
      input: [{ type: "text", text, ...(agentOnly ? { visibility: "agent-only" } : {}) }],
    },
  };
}

function jevResponse(yes: number): Response {
  return new Response(JSON.stringify({
    model: TYPESAFE_MODEL,
    answers: {
      continue: {
        type: "choice",
        choice: yes > 0.5 ? "yes" : "no",
        probabilities: { yes, no: 1 - yes },
        confidence: Math.max(yes, 1 - yes),
      },
    },
    usage: { input_tokens: 100, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation construction", () => {
  it("imports only public SDK and declared public dependencies", () => {
    const packageRoot = fileURLToPath(new URL(".", import.meta.url));
    const scan = experimental_scanPublicSdkOnly(packageRoot, { allow: [/^vitest$/u] });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("keeps complete top-level chat text and excludes agent-only and nested traffic", () => {
    const events: TestEvent[] = [
      userItem(1, "Build the plugin"),
      assistantItem(2, "I can do that. Should I continue?"),
      turnRequest(3, "plugin-request", "please proceed", true),
      userItem(4, "please proceed", "plugin-request"),
      assistantItem(5, "nested result", "tool-1"),
      turnRequest(6, "user-request", "Yes, use the strict threshold"),
      userItem(7, "stale projected text", "user-request"),
      assistantItem(8, "Implemented."),
    ];

    expect(buildConversation(events)).toEqual([
      { role: "user", text: "Build the plugin" },
      { role: "assistant", text: "I can do that. Should I continue?" },
      { role: "user", text: "Yes, use the strict threshold" },
      { role: "assistant", text: "Implemented." },
    ]);
  });

  it("puts the entire conversation in Jev state", () => {
    const conversation = [
      { role: "user" as const, text: "first" },
      { role: "assistant" as const, text: "second" },
      { role: "user" as const, text: "third" },
    ];
    const request = buildJevRequest(conversation);
    expect(JSON.parse(request.state)).toEqual({ conversation });
    expect(request.questions.continue.criteria).toHaveProperty("yes");
    expect(request.questions.continue.criteria).toHaveProperty("no");
  });
});

describe("idle continuation", () => {
  function createHost(yesProbability: number) {
    const idleThread = makeThreadResponse({ id: "thread-1", status: "idle", updatedAt: 100 });
    const events: TestEvent[] = [
      userItem(1, "Finish the implementation and test it."),
      assistantItem(2, "The implementation is ready. Would you like me to run the tests?"),
    ];
    const fetchMock = vi.fn(async () => jevResponse(yesProbability));
    vi.stubGlobal("fetch", fetchMock);
    const host = createFakePluginHost({
      pluginId: "jev-please-proceed",
      settings: { typesafeApiKey: "secret-key" },
      sdk: {
        threads: {
          events: {
            list: async ({ afterSeq }: { afterSeq?: string }) => afterSeq === undefined ? events : [],
          },
          interactions: { list: async () => [] },
          queuedMessages: { list: async () => [] },
          get: async () => idleThread,
          send: async () => ({ ok: true as const, delivery: "sent" as const }),
        },
      },
    });
    return { ...host, idleThread, fetchMock };
  }

  it("sends one agent-only please proceed above the threshold and blocks an identical repeated stop", async () => {
    const { bb, harness, idleThread, fetchMock } = createHost(0.951);
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: idleThread,
      lastAssistantText: "The implementation is ready. Would you like me to run the tests?",
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: { ...idleThread, updatedAt: 101 },
      lastAssistantText: "The implementation is ready. Would you like me to run the tests?",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([[{
      threadId: "thread-1",
      mode: "start",
      input: [{ type: "text", text: "please proceed", mentions: [], visibility: "agent-only" }],
    }]]);
    await harness.lifecycle.dispose();
  });

  it("does not continue when yes probability equals the strict threshold", async () => {
    const { bb, harness, idleThread } = createHost(CONTINUE_THRESHOLD);
    await plugin(bb);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: idleThread,
      lastAssistantText: "Would you like me to continue?",
    });
    expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
