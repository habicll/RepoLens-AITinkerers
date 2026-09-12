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
    { id: "issue-1", kind: "issue", label: "Issue #184", url: issue.url, excerpt: "Signing in with GitHub redirects to the login screen again." },
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
