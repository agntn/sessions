import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sessionsAiTools } from "../../src/ai.ts";
import { sessionsTools } from "../../src/tools.ts";

const allSources = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.ts", () => ({ allSources }));

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A model that calls one tool, then reads the answer and stops.
 * @param toolName - Tool the model calls.
 * @param input - Arguments of that call.
 * @returns {MockLanguageModelV4} The scripted model.
 */
function scriptedModel(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          { type: "tool-call", toolCallId: "call-0", toolName, input: JSON.stringify(input) },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

/**
 * One call through `generateText`.
 * @param toolName - Tool the model calls.
 * @param input - Arguments of that call.
 * @returns {Promise<{ part: unknown; reply: unknown }>} The step part and the model's reply.
 */
async function callThroughModel(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<{ part: unknown; reply: unknown }> {
  const model = scriptedModel(toolName, input);
  const result = await generateText({
    model,
    tools: sessionsAiTools,
    stopWhen: isStepCount(2),
    prompt: "what did I do yesterday?",
  });
  const reply = (model.doGenerateCalls[1]?.prompt ?? [])
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find((part) => part.type === "tool-result")?.output;
  const part = result.steps[0]?.content.find(
    (step) => step.type === "tool-result" || step.type === "tool-error",
  );
  return { part, reply };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("@agntn/sessions/ai", () => {
  it("keys every tool by the name MCP, Pi and OMP use", () => {
    expect(Object.keys(sessionsAiTools)).toEqual(sessionsTools.map((tool) => tool.name));
    expect(Object.values(sessionsAiTools).every((tool) => tool.needsApproval !== true)).toBe(true);
  });

  it("hands the model the same text MCP clients read", async () => {
    allSources.mockReturnValue([
      { name: "codex", available: () => true },
      { name: "claude", available: () => false },
    ]);

    const { reply } = await callThroughModel("sessions_sources", {});

    expect(reply).toEqual({ type: "text", value: "codex\tavailable\nclaude\tunavailable" });
  });

  it("reports a bad argument to the model as a tool error", async () => {
    const { part } = await callThroughModel("sessions_list", { lastHours: 24, mood: "nostalgic" });

    expect(part).toMatchObject({ type: "tool-error" });
    expect(String((part as { error: unknown }).error)).toContain('unknown property "mood"');
  });
});
