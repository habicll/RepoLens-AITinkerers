import { describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { initialState, type Analysis, type IssueRef, type RepoLensState, type Solution, type Source } from "../shared/contracts.js";
import { RepoLensAgent } from "../server/agent.js";
import { analysisOutputSchema, understand, validateEvidence, type Complete, type ModelResponse, type RepositoryReader } from "../server/analysis.js";
import { AnalysisSessionStore } from "../server/session.js";
import { AppError } from "../server/errors.js";

const issue: IssueRef = { owner: "demo", repo: "parser", number: 12, url: "https://github.com/demo/parser/issues/12" };
const sources: Source[] = [
  { id: "issue:12", kind: "issue", url: issue.url, label: "Issue", excerpt: "Parser throws on an empty line." },
  { id: "file:parser", kind: "file", path: "src/parser.ts", lineStart: 1, lineEnd: 2, url: "https://github.com/demo/parser/blob/abc/src/parser.ts#L1-L2", label: "Parser", excerpt: "return line.trim().split(',');" },
];
const analysis: Analysis = {
  summary: { text: "Empty input triggers the reported parser error.", sourceIds: ["issue:12"] }, facts: [], alreadyTried: [],
  relevantFiles: [{ path: "src/parser.ts", reason: "Contains the line parser.", sourceIds: ["file:parser"] }],
  hypotheses: [], relevantContext: [], reproduction: { status: "missing", steps: [], expected: null, actual: null }, howToRun: [], unknowns: ["A runnable reproduction is missing."],
};
const solution: Solution = { status: "proposed", approach: { text: "Investigate empty line handling.", sourceIds: ["file:parser"] }, assumptions: [],
  steps: [{ title: "Inspect empty input", detail: "Review how blank lines are handled.", files: ["src/parser.ts"], validation: "Add a regression test after confirming intended behavior.", sourceIds: ["file:parser"] }], risks: [], openQuestions: [] };

function response(text: string): ModelResponse {
  return { status: "completed", output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] };
}
function repo(): RepositoryReader {
  return {
    metadata: { title: "Empty parser input", state: "open", author: "developer", labels: [], assignees: [], milestone: null },
    sources: structuredClone(sources), snapshot: { id: "snapshot", commitSha: "abc", branch: "main", fetchedAt: new Date().toISOString() },
    coverage: { ...initialState().coverage, filesRead: 1 }, bootstrap: vi.fn(async () => undefined),
    getSeed: () => ({ sources }), overview: vi.fn(async () => ({ paths: ["src/parser.ts"] })),
    search: vi.fn(async () => ({ paths: ["src/parser.ts"] })), readFile: vi.fn(async () => ({ source: sources[1] })),
  };
}
function input(intent = "understand", analysisId?: string, ref = issue): RunAgentInput {
  return { threadId: "thread-one", runId: "run-one", messages: [], tools: [], context: [{ description: "Current GitHub issue", value: JSON.stringify(ref) }], state: {},
    forwardedProps: { intent, issue: ref, ...(analysisId ? { analysisId } : {}) } };
}
async function run(agent: RepoLensAgent, request = input()): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(request).subscribe({ next: event => events.push(event), error: reject, complete: () => resolve(events) });
  });
}
function lastState(events: BaseEvent[]): RepoLensState {
  const event = events.filter(item => item.type === EventType.STATE_SNAPSHOT).at(-1);
  return event?.snapshot as RepoLensState;
}

describe("evidence validation", () => {
  it("requires bounded comment-backed discussion highlights only when comments exist", () => {
    const comment: Source = { id: "comment:42", kind: "comment", url: `${issue.url}#issuecomment-42`, label: "Discussion", excerpt: "The expected behavior remains disputed." };
    const schema = analysisOutputSchema([...sources, comment]);
    const highlight = { text: "Participants disagree about the expected behavior.", sourceIds: [comment.id] };
    expect(schema.safeParse(analysis).success).toBe(false);
    expect(schema.safeParse({ ...analysis, facts: [analysis.summary] }).success).toBe(false);
    expect(schema.safeParse({ ...analysis, facts: [{ ...highlight, sourceIds: ["comment:unknown"] }] }).success).toBe(false);
    expect(schema.safeParse({ ...analysis, facts: [highlight] }).success).toBe(true);
    expect(schema.safeParse({ ...analysis, facts: Array(4).fill(highlight) }).success).toBe(false);
    expect(analysisOutputSchema(sources).safeParse(analysis).success).toBe(true);
  });

  it("rejects internal citation IDs in prose while accepting the same IDs in citation arrays", () => {
    expect(() => validateEvidence(solution, sources)).not.toThrow();
    expect(() => validateEvidence({ ...solution, approach: { ...solution.approach, text: "Investigate empty input. [file:parser]" } }, sources)).toThrow(/citation identifiers/);
    expect(() => validateEvidence({ ...solution, openQuestions: ["What was intended? [issue:12]"] }, sources)).toThrow(/citation identifiers/);
  });

  it("rejects fabricated source IDs and a file cited using a different file's evidence", () => {
    expect(() => validateEvidence(analysis, sources)).not.toThrow();
    expect(() => validateEvidence({ ...analysis, summary: { text: "Claim", sourceIds: ["invented"] } }, sources)).toThrow(/citation/);
    expect(() => validateEvidence({ ...analysis, relevantFiles: [{ path: "src/unknown.ts", reason: "Guessed", sourceIds: ["file:parser"] }] }, sources)).toThrow(/file/);
    expect(() => validateEvidence({ ...solution, steps: [{ ...solution.steps[0], files: ["unread.ts"] }] }, sources)).toThrow(/file/);
  });

  it("rejects invented reproduction steps when the reproduction is missing", () => {
    expect(() => validateEvidence({ ...analysis, reproduction: { ...analysis.reproduction, steps: [analysis.summary] } }, sources)).toThrow(/reproduction/);
  });
});

describe("server snapshot authority", () => {
  it("binds analysis to thread and issue, expires records, and bounds retention", () => {
    let now = 0;
    const store = new AnalysisSessionStore(() => now, 100, 2);
    const state = { ...initialState(issue), analysis, sources };
    const first = store.save("one", issue, state, "{}");
    expect(() => store.get(first.id, "two", issue)).toThrow(/Understand/);
    expect(() => store.get(first.id, "one", { ...issue, number: 13 })).toThrow(/Understand/);
    store.save("two", issue, state, "{}");
    store.save("three", issue, state, "{}");
    expect(() => store.get(first.id, "one", issue)).toThrow(/Understand/);
    const last = store.save("four", issue, state, "{}");
    now = 101;
    expect(() => store.get(last.id, "four", issue)).toThrow(/Understand/);
  });

  it("does not authorize a solution from an analysis supplied by the browser", async () => {
    const complete = vi.fn<Complete>();
    const agent = new RepoLensAgent({ model: "test" }, { complete, sessions: new AnalysisSessionStore(), logger: () => {} });
    const request = input("propose_solution", "fake-analysis");
    request.state = { ...initialState(issue), analysis, analysisId: "fake-analysis" };
    const result = lastState(await run(agent, request));
    expect(result.error?.code).toBe("ANALYSIS_REQUIRED");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps the saved analysis visible when solution generation fails", async () => {
    const sessions = new AnalysisSessionStore();
    const saved = sessions.save("thread-one", issue, { ...initialState(issue), analysis, sources }, "{}");
    const agent = new RepoLensAgent({ model: "test" }, { sessions, complete: async () => { throw new Error("raw secret-bearing provider error"); }, logger: () => {} });
    const result = lastState(await run(agent, input("propose_solution", saved.id)));
    expect(result.analysis).toEqual(analysis);
    expect(result.analysisId).toBe(saved.id);
    expect(result.solution).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
  });
});

describe("AG-UI execution", () => {
  it("clones injected dependencies and publishes a cited result through state events", async () => {
    const repository = repo();
    const complete = vi.fn<Complete>().mockResolvedValueOnce(response("Investigation complete")).mockResolvedValueOnce(response(JSON.stringify(analysis)));
    const sessions = new AnalysisSessionStore();
    const original = new RepoLensAgent({ model: "test" }, { complete, createRepository: () => repository, sessions, logger: () => {} });
    original.threadId = "retained-thread";
    const clone = original.clone();
    expect(clone.threadId).toBe("retained-thread");
    const events = await run(clone);
    const state = lastState(events);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(state.status).toBe("complete");
    expect(state.analysis).toEqual(analysis);
    expect(state.solution).toBeNull();
    expect(state.analysisId).toBeTruthy();
    expect(sessions.get(state.analysisId!, "thread-one", issue).state.analysis).toEqual(analysis);
    expect(complete.mock.calls.every(([request]) => request.store === false)).toBe(true);
    expect(complete.mock.calls.every(([request]) => request.reasoning === undefined)).toBe(true);
  });

  it("checks URL identity and current page coherence before fetching or reasoning", async () => {
    const createRepository = vi.fn(() => repo());
    const agent = new RepoLensAgent({ model: "test" }, { complete: async () => response(""), createRepository, logger: () => {} });
    const request = input();
    request.forwardedProps = { intent: "understand", issue: { ...issue, number: 900 } };
    expect(lastState(await run(agent, request)).error?.code).toBe("INVALID_ISSUE");
    const changed = input();
    changed.context = [{ description: "Current GitHub issue", value: JSON.stringify({ ...issue, number: 13, url: "https://github.com/demo/parser/issues/13" }) }];
    expect(lastState(await run(agent, changed)).error?.code).toBe("STALE_CONTEXT");
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("reports missing OpenAI configuration instead of providing a fabricated result", async () => {
    const createRepository = vi.fn(() => repo());
    const agent = new RepoLensAgent({ model: "test" }, { createRepository, logger: () => {} });
    const state = lastState(await run(agent));
    expect(state.error?.code).toBe("OPENAI_NOT_CONFIGURED");
    expect(state.analysis).toBeNull();
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("unsubscribing aborts pending model work and prevents a late result", async () => {
    let started!: () => void;
    let aborted!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stopped = new Promise<void>(resolve => { aborted = resolve; });
    const complete: Complete = (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("aborted")); }, { once: true });
      started();
    });
    const agent = new RepoLensAgent({ model: "test" }, { complete, createRepository: () => repo(), logger: () => {} });
    const events: BaseEvent[] = [];
    const subscription = agent.run(input()).subscribe(event => events.push(event));
    await ready;
    subscription.unsubscribe();
    await stopped;
    expect(events.some(event => event.type === EventType.RUN_FINISHED)).toBe(false);
    expect(lastState(events).analysis).toBeNull();
  });
});

describe("bounded model workflow", () => {
  it("summarizes collected evidence when repository expansion hits its retrieval cap", async () => {
    const repository = repo();
    repository.readFile = vi.fn(async () => { throw new AppError("CONTEXT_BUDGET", "The six-file budget has been reached.", 429); });
    const complete = vi.fn<Complete>().mockResolvedValueOnce({ status: "completed", output: [
      { type: "function_call", name: "read_file", call_id: "limit-call", arguments: '{"path":"other.ts","startLine":null,"endLine":null}' },
    ] }).mockResolvedValueOnce(response(JSON.stringify(analysis)));
    const result = await understand({ issue, repository, model: "test", complete, signal: new AbortController().signal,
      counts: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, report: () => {}, deadline: Date.now() + 90_000 });
    expect(result.analysis).toEqual(analysis);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].tools).toBeUndefined();
  });

  it("reserves a final structured call and enforces the ten-tool budget", async () => {
    const calls: ResponseCreateParamsNonStreaming[] = [];
    const repository = repo();
    const counts = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
    const complete: Complete = async request => {
      calls.push(request);
      if (!request.tools) return response(JSON.stringify(analysis));
      return { status: "completed", output: Array.from({ length: 4 }, (_, index) => ({ type: "function_call" as const, name: "repo_overview", call_id: `call-${calls.length}-${index}`, arguments: '{"directory":null}' })) };
    };
    const result = await understand({ issue, repository, model: "gpt-5.4", complete, signal: new AbortController().signal, counts, report: () => {}, deadline: Date.now() + 90_000 });
    expect(result.analysis).toEqual(analysis);
    expect(counts.toolCalls).toBe(10);
    expect(counts.modelCalls).toBeLessThanOrEqual(6);
    expect(repository.overview).toHaveBeenCalledTimes(10);
    expect(calls.at(-1)?.tools).toBeUndefined();
    expect(calls.at(-1)?.text?.format?.type).toBe("json_schema");
    expect(calls.every(call => call.store === false)).toBe(true);
    expect(calls.every(call => call.reasoning?.effort === "low")).toBe(true);
  });
});
