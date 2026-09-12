import type { ForensicsCoverage, IssueRef, Source } from "../shared/contracts.js";
import { IssueRefSchema } from "../shared/contracts.js";
import { AppError } from "./errors.js";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2_000_000;

type JsonObject = Record<string, unknown>;
type OptionalState = "available" | "unavailable" | "permission_denied";
type RequestResult = { state: OptionalState; data: unknown };

export interface ForensicsCommitSeed {
  sha: string;
  message: string;
  timestamp: string;
  author: string;
  url: string;
}
export interface ForensicsTimelineSeed {
  id: string;
  event: string;
  timestamp: string;
  title: string;
  url: string;
  pullNumber: number | null;
  commitSha: string | null;
  sourceId: string;
}
export interface ForensicsWorkflowRun {
  id: number;
  name: string;
  title: string;
  timestamp: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  sourceId: string;
}
export interface ForensicsDeployment {
  id: number;
  environment: string;
  timestamp: string;
  sha: string;
  url: string;
  status: string | null;
  sourceId: string;
}
export interface ForensicsPull {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  mergeCommitSha: string;
  sourceId: string;
}
export interface ForensicsCommitDetail extends ForensicsCommitSeed {
  files: string[];
  sourceId: string;
  pull: ForensicsPull | null;
}
export interface ForensicsSeed {
  timeline: ForensicsTimelineSeed[];
  commits: ForensicsCommitSeed[];
  workflows: ForensicsWorkflowRun[];
  deployments: ForensicsDeployment[];
  sources: Source[];
  coverage: ForensicsCoverage;
}
export interface ForensicsInspection {
  commits: ForensicsCommitDetail[];
  deployments: ForensicsDeployment[];
  sources: Source[];
  pullRequestsFound: number;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid Forensics data.", 502, true);
  return value as JsonObject;
}
function text(value: unknown, max = 600): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function integer(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{40,64}$/i.test(result)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid commit SHA.", 502, true);
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 50);
  if (!result || !Number.isFinite(Date.parse(result))) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid timestamp.", 502, true);
  return new Date(result).toISOString();
}
function login(value: unknown): string {
  return value && typeof value === "object" ? text((value as JsonObject).login, 100) || "unknown" : "unknown";
}
function uniqueSources(sources: Source[]): Source[] {
  return [...new Map(sources.map(source => [source.id, source])).values()];
}

export class GitHubForensicsRepository {
  private readonly prefix: string;
  private readonly fullName: string;
  private readonly transport: typeof fetch;

  constructor(
    private readonly issue: IssueRef,
    private readonly options: { token?: string; allowedRepos?: string[]; fetch?: typeof fetch },
    private readonly signal: AbortSignal,
  ) {
    if (!IssueRefSchema.safeParse(issue).success) throw new AppError("INVALID_ISSUE", "Invalid issue reference for Forensics.");
    this.fullName = `${issue.owner}/${issue.repo}`;
    if (options.allowedRepos?.length && !options.allowedRepos.some(repo => repo.toLowerCase() === this.fullName.toLowerCase())) throw new AppError("REPOSITORY_NOT_ALLOWED", "This repository is not enabled on the demo server.", 403);
    this.prefix = `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}`;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, optional = false): Promise<RequestResult> {
    this.signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.transport(`${API}${path}`, {
        headers: {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "RepoLens-Hackathon",
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]), redirect: "manual",
      });
    } catch {
      this.signal.throwIfAborted();
      if (optional) return { state: "unavailable", data: null };
      throw new AppError("GITHUB_UNAVAILABLE", "Could not reach GitHub during the Forensics investigation.", 502, true);
    }
    const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    if (rateLimited) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_RATE_LIMIT", "GitHub's rate limit was reached during the Forensics investigation.", 429, true); }
    if (optional && [401, 403].includes(response.status)) { void response.body?.cancel().catch(() => undefined); return { state: "permission_denied", data: null }; }
    if (optional && [404, 410, 422].includes(response.status)) { void response.body?.cancel().catch(() => undefined); return { state: "unavailable", data: null }; }
    if ([401, 403].includes(response.status)) { void response.body?.cancel().catch(() => undefined); throw new AppError("PERMISSION_DENIED", "GitHub denied access to the issue investigation.", 403); }
    if (response.status === 404 || response.status === 410) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_NOT_FOUND", "The issue or repository is no longer accessible.", 404); }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_MOVED", "This GitHub resource moved. Reopen the current issue and retry.", 409); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); if (optional) return { state: "unavailable", data: null }; throw new AppError("GITHUB_ERROR", `GitHub returned HTTP ${response.status} during Forensics.`, 502, response.status >= 500); }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) { void response.body?.cancel().catch(() => undefined); throw new AppError("RESPONSE_TOO_LARGE", "A GitHub Forensics response exceeded the retrieval budget.", 413); }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new AppError("RESPONSE_TOO_LARGE", "A GitHub Forensics response exceeded the retrieval budget.", 413);
    try { return { state: "available", data: JSON.parse(raw) }; }
    catch { throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid JSON during Forensics.", 502, true); }
  }

  async collect(issueCreatedAt: string, windowDays: number, report: (label: string) => void): Promise<ForensicsSeed> {
    const issueTime = new Date(issueCreatedAt);
    if (!Number.isFinite(issueTime.getTime())) throw new AppError("FORENSICS_MISSING_DATE", "The issue creation time is unavailable; run Understand again.", 409);
    const end = issueTime.toISOString();
    const start = new Date(issueTime.getTime() - windowDays * 86_400_000).toISOString();
    const repository = object((await this.request(this.prefix)).data);
    if (repository.private !== false || text(repository.full_name).toLowerCase() !== this.fullName.toLowerCase()) throw new AppError("PERMISSION_DENIED", "Forensics currently supports public repositories only.", 403);

    report("Reading the issue timeline and recent changes");
    const [timelineResult, commitsResult] = await Promise.all([
      this.request(`${this.prefix}/issues/${this.issue.number}/timeline?per_page=100`),
      this.request(`${this.prefix}/commits?since=${encodeURIComponent(start)}&until=${encodeURIComponent(end)}&per_page=40`),
    ]);
    if (!Array.isArray(timelineResult.data) || !Array.isArray(commitsResult.data)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid timeline or commit data.", 502, true);
    const sources: Source[] = [];
    const timeline = this.parseTimeline(timelineResult.data, sources);
    const commits = this.parseCommits(commitsResult.data);

    report("Checking CI workflows and deployments");
    const createdRange = `${start}..${end}`;
    const [actionsResult, deploymentsResult] = await Promise.all([
      this.request(`${this.prefix}/actions/runs?per_page=100&created=${encodeURIComponent(createdRange)}`, true),
      this.request(`${this.prefix}/deployments?per_page=100`, true),
    ]);
    const workflows = this.parseWorkflows(actionsResult, start, end, sources);
    const deployments = this.parseDeployments(deploymentsResult, start, end);
    const limits: string[] = [];
    if (commits.length === 40) limits.push("Only the first 40 commits in the seven-day window were considered.");
    if (timelineResult.data.length === 100) limits.push("Only the first 100 issue timeline events were considered.");
    if (actionsResult.state !== "available") limits.push(actionsResult.state === "permission_denied" ? "GitHub Actions was not accessible with the configured permissions." : "GitHub Actions data was unavailable.");
    if (deploymentsResult.state !== "available") limits.push(deploymentsResult.state === "permission_denied" ? "Deployments were not accessible with the configured permissions." : "Deployment data was unavailable.");
    return {
      timeline, commits, workflows, deployments, sources: uniqueSources(sources),
      coverage: {
        windowStart: start, windowEnd: end, windowDays, timelineEventsRead: timelineResult.data.length,
        commitsConsidered: commits.length, commitsInspected: 0, pullRequestsFound: 0,
        actions: actionsResult.state, deployments: deploymentsResult.state, limits,
      },
    };
  }

  async inspect(commits: ForensicsCommitSeed[], deployments: ForensicsDeployment[], report: (label: string) => void): Promise<ForensicsInspection> {
    report("Inspecting the strongest commit candidates");
    const detailResults = await Promise.all(commits.slice(0, 6).map(async (commit, index) => {
      const detailResult = await this.request(`${this.prefix}/commits/${encodeURIComponent(commit.sha)}`);
      const pullsResult = index < 4 ? await this.request(`${this.prefix}/commits/${encodeURIComponent(commit.sha)}/pulls?per_page=10`, true) : { state: "unavailable" as const, data: null };
      const detail = object(detailResult.data);
      const files = Array.isArray(detail.files) ? detail.files.slice(0, 30).map(file => text(object(file).filename, 500)).filter(Boolean) : [];
      const sourceId = `commit:${commit.sha}`;
      const commitSource: Source = {
        id: sourceId, kind: "commit", label: `Commit ${commit.sha.slice(0, 7)}`, url: commit.url,
        createdAt: commit.timestamp, author: commit.author,
        excerpt: `Commit: ${commit.sha}\nTimestamp: ${commit.timestamp}\nAuthor: ${commit.author}\nMessage: ${commit.message}\nChanged files: ${files.join(", ") || "not returned"}`,
      };
      const pull = this.parsePull(pullsResult, commit.sha);
      return { ...commit, files, sourceId, pull, sources: [commitSource, ...(pull ? [this.pullSource(pull)] : [])] };
    }));
    const inspectedShas = new Set(detailResults.map(commit => commit.sha));
    const relatedDeployments = deployments.filter(deployment => inspectedShas.has(deployment.sha)).slice(0, 3);
    const deploymentResults = await Promise.all(relatedDeployments.map(async deployment => {
      const statuses = await this.request(`${this.prefix}/deployments/${deployment.id}/statuses?per_page=1`, true);
      let status: string | null = null;
      let timestampValue = deployment.timestamp;
      if (statuses.state === "available" && Array.isArray(statuses.data) && statuses.data.length) {
        const latest = object(statuses.data[0]);
        status = text(latest.state, 80) || null;
        if (latest.created_at) timestampValue = timestamp(latest.created_at);
      }
      const enriched = { ...deployment, status, timestamp: timestampValue };
      const source: Source = {
        id: enriched.sourceId, kind: "deployment", label: `Deployment ${enriched.id} · ${enriched.environment}`,
        url: enriched.url, createdAt: enriched.timestamp,
        excerpt: `Deployment: ${enriched.id}\nEnvironment: ${enriched.environment}\nCommit: ${enriched.sha}\nCreated: ${deployment.timestamp}\nLatest status: ${enriched.status ?? "unavailable"}`,
      };
      return { deployment: enriched, source };
    }));
    return {
      commits: detailResults.map(({ sources: _sources, ...commit }) => commit),
      deployments: deploymentResults.map(result => result.deployment),
      sources: uniqueSources([...detailResults.flatMap(result => result.sources), ...deploymentResults.map(result => result.source)]),
      pullRequestsFound: new Set(detailResults.flatMap(commit => commit.pull ? [commit.pull.number] : [])).size,
    };
  }

  private parseTimeline(values: unknown[], sources: Source[]): ForensicsTimelineSeed[] {
    const result: ForensicsTimelineSeed[] = [];
    for (const [index, value] of values.entries()) {
      const event = object(value);
      const eventName = text(event.event, 80);
      const createdAt = event.created_at ? timestamp(event.created_at) : null;
      if (!eventName || !createdAt) continue;
      let pullNumber: number | null = null;
      let commitSha: string | null = null;
      let title = eventName.replace(/_/g, " ");
      let url = this.issue.url;
      if (event.source && typeof event.source === "object") {
        const source = object(event.source);
        if (source.issue && typeof source.issue === "object") {
          const sourceIssue = object(source.issue);
          if (sourceIssue.pull_request) pullNumber = integer(sourceIssue.number) || null;
          title = pullNumber ? `Referenced by PR #${pullNumber}: ${text(sourceIssue.title, 220)}` : `Referenced by issue #${integer(sourceIssue.number)}: ${text(sourceIssue.title, 220)}`;
          url = text(sourceIssue.html_url, 800) || url;
        }
      }
      const rawCommit = text(event.commit_id, 64);
      if (/^[a-f0-9]{40,64}$/i.test(rawCommit)) { commitSha = rawCommit; title = `Commit ${rawCommit.slice(0, 7)} referenced in the issue`; url = `https://github.com/${this.fullName}/commit/${rawCommit}`; }
      if (!pullNumber && !commitSha && !["closed", "reopened", "deployed", "referenced", "cross-referenced", "committed"].includes(eventName)) continue;
      const sourceId = `timeline:${integer(event.id) || index + 1}`;
      sources.push({ id: sourceId, kind: "timeline", label: `Issue timeline · ${eventName}`, url, createdAt, excerpt: `Event: ${eventName}\nTimestamp: ${createdAt}\nDescription: ${title}` });
      result.push({ id: sourceId, event: eventName, timestamp: createdAt, title, url, pullNumber, commitSha, sourceId });
    }
    return result.slice(0, 30);
  }

  private parseCommits(values: unknown[]): ForensicsCommitSeed[] {
    const commits: ForensicsCommitSeed[] = [];
    for (const value of values.slice(0, 40)) {
      const item = object(value);
      const commit = object(item.commit);
      const committer = commit.committer ? object(commit.committer) : {};
      const author = commit.author ? object(commit.author) : {};
      const commitSha = sha(item.sha);
      commits.push({
        sha: commitSha, message: text(commit.message, 800).split("\n")[0] || "Untitled commit",
        timestamp: timestamp(committer.date || author.date), author: login(item.author) !== "unknown" ? login(item.author) : text(author.name, 100) || "unknown",
        url: text(item.html_url, 800) || `https://github.com/${this.fullName}/commit/${commitSha}`,
      });
    }
    return commits;
  }

  private parseWorkflows(result: RequestResult, start: string, end: string, sources: Source[]): ForensicsWorkflowRun[] {
    if (result.state !== "available") return [];
    const data = object(result.data);
    if (!Array.isArray(data.workflow_runs)) return [];
    const runs: ForensicsWorkflowRun[] = [];
    for (const value of data.workflow_runs.slice(0, 100)) {
      const item = object(value);
      const createdAt = timestamp(item.created_at);
      if (createdAt < start || createdAt > end) continue;
      const headSha = text(item.head_sha, 64);
      if (!/^[a-f0-9]{40,64}$/i.test(headSha)) continue;
      const id = integer(item.id);
      if (!id) continue;
      const run: ForensicsWorkflowRun = {
        id, name: text(item.name, 200) || "GitHub Actions", title: text(item.display_title, 250) || text(item.name, 200) || `Workflow run ${id}`,
        timestamp: createdAt, status: text(item.status, 80) || "unknown", conclusion: text(item.conclusion, 80) || null,
        headSha, url: text(item.html_url, 800) || `https://github.com/${this.fullName}/actions/runs/${id}`, sourceId: `workflow:${id}`,
      };
      sources.push({ id: run.sourceId, kind: "workflow", label: `${run.name} · run ${id}`, url: run.url, createdAt: run.timestamp, excerpt: `Workflow: ${run.name}\nRun: ${id}\nCommit: ${run.headSha}\nCreated: ${run.timestamp}\nStatus: ${run.status}\nConclusion: ${run.conclusion ?? "not completed"}` });
      runs.push(run);
    }
    return runs;
  }

  private parseDeployments(result: RequestResult, start: string, end: string): ForensicsDeployment[] {
    if (result.state !== "available" || !Array.isArray(result.data)) return [];
    const deployments: ForensicsDeployment[] = [];
    for (const value of result.data.slice(0, 100)) {
      const item = object(value);
      const createdAt = timestamp(item.created_at);
      const deploymentSha = text(item.sha, 64);
      if (createdAt < start || createdAt > end || !/^[a-f0-9]{40,64}$/i.test(deploymentSha)) continue;
      const id = integer(item.id);
      if (!id) continue;
      deployments.push({ id, environment: text(item.environment, 160) || "environment", timestamp: createdAt, sha: deploymentSha,
        url: `https://github.com/${this.fullName}/deployments`, status: null, sourceId: `deployment:${id}` });
    }
    return deployments;
  }

  private parsePull(result: RequestResult, commitSha: string): ForensicsPull | null {
    if (result.state !== "available" || !Array.isArray(result.data)) return null;
    for (const value of result.data.slice(0, 10)) {
      const pull = object(value);
      if (!pull.merged_at) continue;
      const number = integer(pull.number);
      if (!number) continue;
      const mergeCommitSha = text(pull.merge_commit_sha, 64);
      return { number, title: text(pull.title, 300) || `Pull request #${number}`, url: text(pull.html_url, 800) || `https://github.com/${this.fullName}/pull/${number}`,
        mergedAt: timestamp(pull.merged_at), mergeCommitSha: /^[a-f0-9]{40,64}$/i.test(mergeCommitSha) ? mergeCommitSha : commitSha, sourceId: `pull_request:${number}` };
    }
    return null;
  }

  private pullSource(pull: ForensicsPull): Source {
    return { id: pull.sourceId, kind: "pull_request", label: `PR #${pull.number}`, url: pull.url, createdAt: pull.mergedAt,
      excerpt: `Pull request: #${pull.number}\nTitle: ${pull.title}\nMerged: ${pull.mergedAt}\nMerge commit: ${pull.mergeCommitSha}` };
  }
}
