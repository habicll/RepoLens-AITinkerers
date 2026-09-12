import { describe, expect, it, vi } from "vitest";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { fixtureState } from "./fixture-data.js";
import type { ForensicsReader } from "../server/forensics.js";
import { investigateIssue, shortlistCommits } from "../server/forensics.js";
import { GitHubForensicsRepository, type ForensicsCommitSeed, type ForensicsSeed } from "../server/forensics-github.js";
import type { Complete, ModelResponse } from "../server/analysis.js";
import type { IssueRef, Source } from "../shared/contracts.js";

const issue: IssueRef = { owner: "demo", repo: "project", number: 12, url: "https://github.com/demo/project/issues/12" };
const sha = "8fd22a" + "b".repeat(34);
const issueCreatedAt = "2026-09-12T09:42:00.000Z";
const state = fixtureState(issue);
state.sources[0]!.createdAt = issueCreatedAt;

function modelResponse(value: unknown): ModelResponse {
  return { status: "completed", output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] };
}

function seed(commits = [{ sha, message: "refactor OAuth session validation", timestamp: "2026-09-12T08:30:00.000Z", author: "developer", url: `https://github.com/demo/project/commit/${sha}` }]): ForensicsSeed {
  const workflow: Source = { id: "workflow:824", kind: "workflow", label: "Auth · run 824", url: "https://github.com/demo/project/actions/runs/824", createdAt: "2026-09-12T08:37:00.000Z", excerpt: `Auth failed on ${sha}.` };
  return {
    commits, timeline: [{ id: "timeline:1", event: "cross-referenced", timestamp: "2026-09-12T09:10:00.000Z", title: "Referenced by PR #461", url: "https://github.com/demo/project/pull/461", pullNumber: 461, commitSha: null, sourceId: "timeline:1" }],
    workflows: [{ id: 824, name: "Authentication", title: "Session tests", timestamp: "2026-09-12T08:37:00.000Z", status: "completed", conclusion: "failure", headSha: sha, url: workflow.url, sourceId: workflow.id }],
    deployments: [{ id: 93, environment: "production", timestamp: "2026-09-12T08:51:00.000Z", sha, url: "https://github.com/demo/project/deployments", status: null, sourceId: "deployment:93" }],
    sources: [workflow, { id: "timeline:1", kind: "timeline", label: "Issue timeline", url: "https://github.com/demo/project/pull/461", createdAt: "2026-09-12T09:10:00.000Z", excerpt: "PR #461 referenced the issue." }],
    coverage: { windowStart: "2026-09-05T09:42:00.000Z", windowEnd: issueCreatedAt, windowDays: 7, timelineEventsRead: 1, commitsConsidered: commits.length, commitsInspected: 0, pullRequestsFound: 0, actions: "available", deployments: "available", limits: [] },
  };
}

function reader(commits = seed().commits): ForensicsReader {
  return {
    collect: vi.fn(async () => seed(commits)),
    inspect: vi.fn(async (selected: ForensicsCommitSeed[]) => ({ commits: selected.map(commit => ({ ...commit, files: ["src/auth/middleware.ts", "src/auth/session.ts"], sourceId: `commit:${commit.sha}`,
      pull: { number: 461, title: "OAuth session refactor", url: "https://github.com/demo/project/pull/461", mergedAt: "2026-09-12T08:32:00.000Z", mergeCommitSha: commit.sha, sourceId: "pull_request:461" } })),
      deployments: commits.length ? [{ ...seed().deployments[0]!, status: "success" }] : [], pullRequestsFound: commits.length ? 1 : 0,
      sources: commits.length ? [
        { id: `commit:${sha}`, kind: "commit", label: "Commit 8fd22ab", url: `https://github.com/demo/project/commit/${sha}`, createdAt: "2026-09-12T08:30:00.000Z", excerpt: "OAuth session refactor changed authentication files." },
        { id: "pull_request:461", kind: "pull_request", label: "PR #461", url: "https://github.com/demo/project/pull/461", createdAt: "2026-09-12T08:32:00.000Z", excerpt: "OAuth session refactor." },
        { id: "deployment:93", kind: "deployment", label: "Deployment 93", url: "https://github.com/demo/project/deployments", createdAt: "2026-09-12T08:51:00.000Z", excerpt: "Production deployment succeeded." },
      ] as Source[] : [] })),
  };
}

describe("Forensics analysis", () => {
  it("ranks GitHub evidence deterministically and uses one model call only for semantic relevance", async () => {
    const complete = vi.fn<Complete>().mockResolvedValue(modelResponse({
      summary: { text: "The authentication deployment is the strongest regression candidate before the report.", sourceIds: ["pull_request:461", "workflow:824", "deployment:93"] },
      assessments: [{ candidateId: "candidate:pr-461", semanticRelevance: "high", inference: "The session refactor may have introduced the reported authentication regression.", sourceIds: ["pull_request:461", `commit:${sha}`, "file-1", "file-2"] }],
      inferences: [],
    }));
    const counts = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
    const result = await investigateIssue({ issue, metadata: state.metadata, analysis: state.analysis!, sources: state.sources, reader: reader(), windowDays: 7,
      model: "test", complete, signal: new AbortController().signal, counts, report: () => undefined });
    expect(result.result.status).toBe("likely_regression");
    expect(result.result.candidates[0]).toMatchObject({ id: "candidate:pr-461", confidence: "high", signals: expect.arrayContaining(["temporal", "path", "ci", "deployment", "semantic"]) });
    expect(result.result.timeline.map(event => event.type)).toEqual(expect.arrayContaining(["pull_request", "workflow", "deployment", "issue"]));
    expect(result.result.facts.some(fact => fact.text.includes("Authentication concluded failure"))).toBe(true);
    expect(result.result.inferences[0]?.text).toContain("may have introduced");
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![0] as ResponseCreateParamsNonStreaming;
    expect(request.store).toBe(false);
    expect(JSON.stringify(request.input)).not.toContain("OPENAI_API_KEY");
  });

  it("returns no evidence instead of asking the model to invent a culprit", async () => {
    const complete = vi.fn<Complete>();
    const result = await investigateIssue({ issue, metadata: state.metadata, analysis: state.analysis!, sources: state.sources, reader: reader([]), windowDays: 7,
      model: "test", complete, signal: new AbortController().signal, counts: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, report: () => undefined });
    expect(result.result).toMatchObject({ status: "no_strong_evidence", mostLikelyCandidateId: null, candidates: [] });
    expect(result.result.summary.text).toContain("No commits were found");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps an unrelated candidate low and explicitly reports no strong evidence", async () => {
    const unrelated = { sha: "c".repeat(40), message: "update contributor guide", timestamp: "2026-09-06T09:42:00.000Z", author: "docs", url: "https://github.com/demo/project/commit/ccccccc" };
    const evidence: Source = { id: `commit:${unrelated.sha}`, kind: "commit", label: "Commit ccccccc", url: unrelated.url, createdAt: unrelated.timestamp, excerpt: "Update contributor guide. Changed docs/contributing.md." };
    const lowReader: ForensicsReader = {
      collect: async () => seed([unrelated]),
      inspect: async () => ({ commits: [{ ...unrelated, files: ["docs/contributing.md"], sourceId: evidence.id, pull: null }], deployments: [], sources: [evidence], pullRequestsFound: 0 }),
    };
    const complete = vi.fn<Complete>().mockResolvedValue(modelResponse({ summary: { text: "The available change is not semantically related to the authentication report.", sourceIds: [evidence.id, "issue-1"] },
      assessments: [{ candidateId: "candidate:commit-cccccccccccc", semanticRelevance: "low", inference: "The documentation update is unlikely to explain the session failure.", sourceIds: [evidence.id, "issue-1"] }], inferences: [] }));
    const result = await investigateIssue({ issue, metadata: state.metadata, analysis: state.analysis!, sources: state.sources, reader: lowReader, windowDays: 7,
      model: "test", complete, signal: new AbortController().signal, counts: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, report: () => undefined });
    expect(result.result.status).toBe("no_strong_evidence");
    expect(result.result.mostLikelyCandidateId).toBeNull();
    expect(result.result.candidates[0]?.confidence).toBe("low");
    expect(result.result.summary.text).toContain("No strong regression candidate");
  });

  it("shortlists a small relevant window instead of inspecting every commit", () => {
    const commits = Array.from({ length: 20 }, (_, index) => ({ sha: index.toString(16).padStart(40, "a"), message: index === 18 ? "OAuth middleware session regression" : `documentation update ${index}`,
      timestamp: new Date(Date.parse(issueCreatedAt) - (index + 1) * 3_600_000).toISOString(), author: "dev", url: `https://github.com/demo/project/commit/${index}` }));
    const selected = shortlistCommits(seed(commits), state.analysis!, state.metadata, issueCreatedAt);
    expect(selected).toHaveLength(6);
    expect(selected.some(commit => commit.message.includes("OAuth middleware"))).toBe(true);
  });
});

describe("GitHub Forensics retrieval", () => {
  it("uses bounded endpoints and degrades when optional Actions data is inaccessible", async () => {
    const requests: URL[] = [];
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); requests.push(url);
      if (url.pathname === "/repos/demo/project") return json({ full_name: "demo/project", private: false });
      if (url.pathname.endsWith("/issues/12/timeline")) return json([]);
      if (url.pathname.endsWith("/commits") && !url.pathname.includes(sha)) return json([{ sha, html_url: `https://github.com/demo/project/commit/${sha}`, author: { login: "dev" }, commit: { message: "OAuth session refactor", author: { name: "Dev", date: "2026-09-12T08:30:00Z" }, committer: { date: "2026-09-12T08:30:00Z" } } }]);
      if (url.pathname.endsWith("/actions/runs")) return json({}, 403);
      if (url.pathname.endsWith("/deployments")) return json([{ id: 93, environment: "production", created_at: "2026-09-12T08:51:00Z", sha }]);
      if (url.pathname.endsWith(`/commits/${sha}`)) return json({ files: [{ filename: "src/auth/session.ts" }] });
      if (url.pathname.endsWith(`/commits/${sha}/pulls`)) return json([{ number: 461, title: "OAuth session refactor", html_url: "https://github.com/demo/project/pull/461", merged_at: "2026-09-12T08:32:00Z", merge_commit_sha: sha }]);
      if (url.pathname.endsWith("/deployments/93/statuses")) return json([{ state: "success", created_at: "2026-09-12T08:52:00Z" }]);
      throw new Error(`Unexpected request ${url.pathname}`);
    }) as typeof fetch;
    const repository = new GitHubForensicsRepository(issue, { fetch: fetcher }, new AbortController().signal);
    const collected = await repository.collect(issueCreatedAt, 7, () => undefined);
    expect(collected.coverage).toMatchObject({ commitsConsidered: 1, actions: "permission_denied", deployments: "available" });
    expect(collected.coverage.limits.join(" ")).toContain("GitHub Actions was not accessible");
    const inspected = await repository.inspect(collected.commits, collected.deployments, () => undefined);
    expect(inspected.commits[0]).toMatchObject({ files: ["src/auth/session.ts"], pull: { number: 461 } });
    expect(inspected.deployments[0]).toMatchObject({ id: 93, status: "success" });
    expect(requests.some(url => url.searchParams.get("per_page") === "40")).toBe(true);
    expect(requests).toHaveLength(8);
  });
});
