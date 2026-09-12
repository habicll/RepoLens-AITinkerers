// Synthetic data for automated tests only. Never imported by the application.
import { initialRepositoryState, initialState, type RepoLensState, type IssueRef, type RepositoryRef } from "../shared/contracts.js";

export function fixtureState(issue: IssueRef, runId = "fixture-run"): RepoLensState {
  const state = initialState(issue);
  const sha = "a".repeat(40);
  state.runId = runId;
  state.metadata = { title: "Session rejected after OAuth callback", state: "open", author: "test-user", labels: ["bug"], assignees: [], milestone: null };
  state.snapshot = { id: "fixture-snapshot", commitSha: sha, branch: "main", fetchedAt: "2026-09-12T10:00:00Z" };
  state.coverage = { commentsTotal: 28, commentsRead: 28, commentsTruncated: false, filesRead: 2, pathsDiscovered: 24, treeTruncated: false, codeSearch: "not_used", limits: [] };
  state.sources = [
    { id: "issue-1", kind: "issue", label: "Issue #184", url: issue.url, createdAt: "2026-09-12T09:42:00Z", excerpt: "Signing in with GitHub redirects to the login screen again." },
    { id: "comment-21", kind: "comment", label: "Comment #21", url: `${issue.url}#issuecomment-21`, author: "test-maintainer", excerpt: "The OAuth callback succeeds. I verified the callback URL and cleared cookies, but the session is still rejected." },
    { id: "file-1", kind: "file", label: "src/auth/middleware.ts:12–15", url: `https://github.com/${issue.owner}/${issue.repo}/blob/${sha}/src/auth/middleware.ts#L12-L15`, path: "src/auth/middleware.ts", lineStart: 12, lineEnd: 15, excerpt: "12: if (!session.userId) {\n13:   return redirect('/login');\n14: }" },
    { id: "file-2", kind: "file", label: "src/auth/callback.ts:8–10", url: `https://github.com/${issue.owner}/${issue.repo}/blob/${sha}/src/auth/callback.ts#L8-L10`, path: "src/auth/callback.ts", lineStart: 8, lineEnd: 10, excerpt: "8: session.sub = identity.id;\n9: await session.save();" },
  ];
  state.analysisId = "fixture-analysis";
  state.analysis = {
    summary: { text: "The OAuth callback succeeds, but the session is rejected immediately after sign-in.", sourceIds: ["issue-1", "comment-21"] },
    facts: [{ text: "The callback URL was verified and clearing cookies did not resolve the redirect.", sourceIds: ["comment-21"] }],
    alreadyTried: [{ action: "Verified the callback URL and cleared cookies", outcome: "The session is still rejected.", status: "attempted", sourceIds: ["comment-21"] }],
    relevantFiles: [
      { path: "src/auth/middleware.ts", reason: "Validates the session before allowing the request.", sourceIds: ["file-1"] },
      { path: "src/auth/callback.ts", reason: "Stores the OAuth identity in the session.", sourceIds: ["file-2"] },
    ],
    hypotheses: [{ text: "The session identity fields may not match.", confidence: "medium", rationale: "The callback writes sub while the middleware reads userId.", sourceIds: ["file-1", "file-2"], unknowns: ["Other session writers have not been inspected."] }],
    relevantContext: [{ text: "Only the authentication and session flow is relevant to the observed redirect.", sourceIds: ["file-1", "file-2"] }],
    reproduction: { status: "documented", steps: [{ text: "Sign in with GitHub and observe the redirect to the login screen.", sourceIds: ["issue-1"] }], expected: { text: "An authenticated session.", sourceIds: ["issue-1"] }, actual: { text: "A redirect back to login.", sourceIds: ["issue-1"] } },
    howToRun: [], unknowns: ["Local startup commands are not documented in the inspected sources."],
  };
  state.status = "complete";
  state.phase = "Analysis ready";
  state.activities = [{ id: "comments", label: "Read 28 comments", status: "done" }, { id: "code", label: "Read 2 relevant files", status: "done" }];
  return state;
}

export function fixtureForensics(state: RepoLensState): RepoLensState {
  const issue = state.issue!;
  const sha = "8fd22a" + "b".repeat(34);
  state.sources.push(
    { id: `commit:${sha}`, kind: "commit", label: "Commit 8fd22ab", url: `https://github.com/${issue.owner}/${issue.repo}/commit/${sha}`, createdAt: "2026-09-12T08:32:00Z", excerpt: "OAuth session refactor. Changed src/auth/session.ts and src/auth/middleware.ts." },
    { id: "pull_request:461", kind: "pull_request", label: "PR #461", url: `https://github.com/${issue.owner}/${issue.repo}/pull/461`, createdAt: "2026-09-12T08:32:00Z", excerpt: `PR #461 OAuth session refactor. Merge commit ${sha}.` },
    { id: "workflow:824", kind: "workflow", label: "Authentication · run 824", url: `https://github.com/${issue.owner}/${issue.repo}/actions/runs/824`, createdAt: "2026-09-12T08:37:00Z", excerpt: `Authentication failed on ${sha}.` },
    { id: "deployment:93", kind: "deployment", label: "Deployment 93 · production", url: `https://github.com/${issue.owner}/${issue.repo}/deployments`, createdAt: "2026-09-12T08:51:00Z", excerpt: `Production deployment succeeded for ${sha}.` },
  );
  const candidateId = "candidate:pr-461";
  const candidateFacts = [
    { text: "PR #461 was merged 70 minutes before the issue was created.", sourceIds: ["pull_request:461", `commit:${sha}`] },
    { text: "PR #461 changed src/auth/session.ts and src/auth/middleware.ts.", sourceIds: [`commit:${sha}`, "pull_request:461"] },
    { text: "Authentication concluded failure on commit 8fd22ab.", sourceIds: ["workflow:824", `commit:${sha}`] },
    { text: "Deployment 93 targeted production with commit 8fd22ab and reported success.", sourceIds: ["deployment:93", `commit:${sha}`] },
  ];
  state.forensics = {
    status: "likely_regression", summary: { text: "The issue is likely a regression associated with the authentication deployment shortly before the first report.", sourceIds: ["pull_request:461", "workflow:824", "deployment:93", "issue-1"] },
    mostLikelyCandidateId: candidateId,
    candidates: [{ id: candidateId, type: "pull_request", title: "OAuth session refactor", url: `https://github.com/${issue.owner}/${issue.repo}/pull/461`, sha, number: 461,
      timestamp: "2026-09-12T08:32:00Z", confidence: "high", facts: candidateFacts,
      inference: { text: "The OAuth session refactor probably introduced the regression.", sourceIds: ["pull_request:461", `commit:${sha}`, "file-1", "file-2"] },
      changedFiles: ["src/auth/session.ts", "src/auth/middleware.ts"], signals: ["temporal", "path", "ci", "deployment", "semantic"] }],
    timeline: [
      { id: "change", timestamp: "2026-09-12T08:32:00Z", type: "pull_request", title: "PR #461 merged · OAuth session refactor", description: null, status: "candidate", url: `https://github.com/${issue.owner}/${issue.repo}/pull/461`, sourceIds: ["pull_request:461"] },
      { id: "workflow", timestamp: "2026-09-12T08:37:00Z", type: "workflow", title: "Authentication workflow failed", description: "Commit 8fd22ab", status: "failure", url: `https://github.com/${issue.owner}/${issue.repo}/actions/runs/824`, sourceIds: ["workflow:824"] },
      { id: "deployment", timestamp: "2026-09-12T08:51:00Z", type: "deployment", title: "Deployment to production", description: "Commit 8fd22ab", status: "success", url: `https://github.com/${issue.owner}/${issue.repo}/deployments`, sourceIds: ["deployment:93"] },
      { id: "issue", timestamp: "2026-09-12T09:42:00Z", type: "issue", title: "Issue #184 created", description: "First report timestamp used by this investigation.", status: "reported", url: issue.url, sourceIds: ["issue-1"] },
    ],
    facts: candidateFacts,
    inferences: [{ text: "The OAuth session refactor probably introduced the regression.", sourceIds: ["pull_request:461", `commit:${sha}`, "file-1", "file-2"] }],
    coverage: { windowStart: "2026-09-05T09:42:00Z", windowEnd: "2026-09-12T09:42:00Z", windowDays: 7, timelineEventsRead: 12, commitsConsidered: 18, commitsInspected: 4, pullRequestsFound: 2, actions: "available", deployments: "available", limits: [] },
  };
  state.forensicsStatus = "complete";
  state.forensicsPhase = "Forensics investigation ready";
  state.forensicsActivities = [{ id: "forensics", label: "Building evidence", status: "done" }];
  return state;
}

export function fixtureRepositoryState(repository: RepositoryRef, runId = "fixture-repository-run"): RepoLensState {
  const state = initialRepositoryState(repository);
  const sha = "b".repeat(40);
  state.runId = runId;
  state.repositoryMetadata = { name: repository.repo, description: "An evidence-backed GitHub context assistant", language: "TypeScript", stars: 128, topics: ["github", "agents"], license: "MIT" };
  state.snapshot = { id: "fixture-repository-snapshot", commitSha: sha, branch: "main", fetchedAt: "2026-09-12T10:00:00Z" };
  state.coverage = { commentsTotal: 0, commentsRead: 0, commentsTruncated: false, filesRead: 2, pathsDiscovered: 18, treeTruncated: false, codeSearch: "not_used", limits: [] };
  state.sources = [
    { id: "repository:metadata", kind: "repository", label: `${repository.owner}/${repository.repo}`, url: repository.url, excerpt: "An evidence-backed GitHub context assistant written in TypeScript." },
    { id: "readme:root", kind: "readme", label: "README.md:1–40", url: `${repository.url}/blob/${sha}/README.md`, path: "README.md", lineStart: 1, lineEnd: 40, excerpt: "RepoLens explains GitHub repositories and issues. Run npm ci, then npm run dev." },
    { id: "file:package.json", kind: "file", label: "package.json:1–20", url: `${repository.url}/blob/${sha}/package.json`, path: "package.json", lineStart: 1, lineEnd: 20, excerpt: "scripts: dev, test, build" },
  ];
  state.repositoryAnalysisId = "11111111-1111-4111-8111-111111111111";
  state.repositoryAnalysis = {
    summary: { text: "RepoLens turns GitHub context into a concise, source-backed engineering briefing.", sourceIds: ["readme:root"] },
    whatItDoes: { text: "It reads a repository or issue and surfaces only the context needed to start working.", sourceIds: ["readme:root"] },
    audience: { text: "Developers joining a repository or picking up a complex issue.", sourceIds: ["readme:root"] },
    keyConcepts: [{ text: "GitHub evidence remains linked to every factual statement.", sourceIds: ["readme:root"] }],
    architecture: [{ text: "The project uses a TypeScript client, server, shared contracts, and a Chrome extension.", sourceIds: ["readme:root", "file:package.json"] }],
    quickStart: [{ text: "Install dependencies with npm ci, then start development with npm run dev.", sourceIds: ["readme:root", "file:package.json"] }],
    importantSections: [{ title: "Architecture", explanation: "Explains how GitHub context moves through the application.", sourceIds: ["readme:root"] }],
    unknowns: ["The fixture does not execute the documented commands."],
  };
  state.launchProposal = { status: "disabled", runtime: "Node.js + npm", commands: ["npm ci", "npm run dev"], reason: "Local execution is disabled on this RepoLens server.", requiresApproval: true };
  state.status = "complete";
  state.phase = "Repository briefing ready";
  state.activities = [{ id: "readme", label: "Read README and package.json", status: "done" }];
  return state;
}
