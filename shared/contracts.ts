import { z } from "zod";

export const IssueRefSchema = z.object({
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/),
  repo: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string().url(),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

export const RepositoryRefSchema = z.object({
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/),
  repo: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  url: z.string().url(),
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export function parseIssueUrl(value: string): IssueRef | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const result = IssueRefSchema.safeParse({ owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` });
    return result.success ? result.data : null;
  } catch { return null; }
}
export function issueKey(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export function parseRepositoryUrl(value: string): RepositoryRef | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
    const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    const reserved = new Set(["about", "collections", "customer-stories", "enterprise", "events", "features", "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "readme", "search", "security", "settings", "signup", "sponsors", "topics"]);
    if (!match || match[2].endsWith(".git") || reserved.has(match[1].toLowerCase())) return null;
    const result = RepositoryRefSchema.safeParse({ owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` });
    return result.success ? result.data : null;
  } catch { return null; }
}
export function repositoryKey(ref: RepositoryRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

export const ClaimSchema = z.object({
  text: z.string().min(1).max(900),
  sourceIds: z.array(z.string()).min(1).max(6),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const AnalysisSchema = z.object({
  summary: ClaimSchema,
  facts: z.array(ClaimSchema).max(3),
  alreadyTried: z.array(z.object({
    action: z.string().max(350),
    outcome: z.string().max(450),
    status: z.enum(["attempted", "suggested"]),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(4),
  relevantFiles: z.array(z.object({
    path: z.string(),
    reason: z.string().max(500),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(4),
  hypotheses: z.array(z.object({
    text: z.string().max(500),
    confidence: z.enum(["low", "medium", "high"]),
    rationale: z.string().max(700),
    sourceIds: z.array(z.string()).min(1).max(6),
    unknowns: z.array(z.string()).max(4),
  })).max(2),
  relevantContext: z.array(ClaimSchema).max(4),
  reproduction: z.object({
    status: z.enum(["documented", "inferred", "missing"]),
    steps: z.array(ClaimSchema).max(6),
    expected: ClaimSchema.nullable(),
    actual: ClaimSchema.nullable(),
  }),
  howToRun: z.array(ClaimSchema).max(4),
  unknowns: z.array(z.string().max(500)).max(6),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const SolutionSchema = z.object({
  status: z.enum(["proposed", "needs_more_information"]),
  approach: ClaimSchema,
  assumptions: z.array(z.string().max(500)).max(5),
  steps: z.array(z.object({
    title: z.string().max(150),
    detail: z.string().max(700),
    files: z.array(z.string()).max(5),
    validation: z.string().max(500),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(6),
  risks: z.array(z.string().max(500)).max(4),
  openQuestions: z.array(z.string().max(500)).max(4),
});
export type Solution = z.infer<typeof SolutionSchema>;

export const ImplementationDraftSchema = z.object({
  status: z.enum(["drafted", "needs_more_information"]),
  summary: ClaimSchema,
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    explanation: z.string().min(1).max(500),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(5),
  patch: z.string().max(24_000),
  validationCommands: z.array(z.string().min(1).max(300)).max(6),
  notes: z.array(z.string().min(1).max(500)).max(5),
});
export type ImplementationDraft = z.infer<typeof ImplementationDraftSchema>;

export const ForensicsTimelineEventSchema = z.object({
  id: z.string().min(1).max(160),
  timestamp: z.string().datetime(),
  type: z.enum(["issue", "pull_request", "commit", "workflow", "deployment"]),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(600).nullable(),
  status: z.string().max(80).nullable(),
  url: z.string().url(),
  sourceIds: z.array(z.string()).min(1).max(4),
});
export type ForensicsTimelineEvent = z.infer<typeof ForensicsTimelineEventSchema>;

export const RegressionCandidateSchema = z.object({
  id: z.string().min(1).max(160),
  type: z.enum(["pull_request", "commit"]),
  title: z.string().min(1).max(300),
  url: z.string().url(),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  number: z.number().int().positive().nullable(),
  timestamp: z.string().datetime(),
  confidence: z.enum(["high", "medium", "low"]),
  facts: z.array(ClaimSchema).min(1).max(6),
  inference: ClaimSchema.nullable(),
  changedFiles: z.array(z.string().min(1).max(500)).max(12),
  signals: z.array(z.enum(["temporal", "path", "message", "ci", "deployment", "timeline", "semantic"])).max(7),
});
export type RegressionCandidate = z.infer<typeof RegressionCandidateSchema>;

export const ForensicsCoverageSchema = z.object({
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  windowDays: z.number().int().min(1).max(30),
  timelineEventsRead: z.number().int().nonnegative(),
  commitsConsidered: z.number().int().nonnegative(),
  commitsInspected: z.number().int().nonnegative(),
  pullRequestsFound: z.number().int().nonnegative(),
  actions: z.enum(["available", "unavailable", "permission_denied", "rate_limited"]),
  deployments: z.enum(["available", "unavailable", "permission_denied", "rate_limited"]),
  limits: z.array(z.string().min(1).max(500)).max(10),
});
export type ForensicsCoverage = z.infer<typeof ForensicsCoverageSchema>;

export const ForensicsResultSchema = z.object({
  status: z.enum(["likely_regression", "possible_candidates", "no_strong_evidence"]),
  summary: ClaimSchema,
  mostLikelyCandidateId: z.string().min(1).max(160).nullable(),
  timeline: z.array(ForensicsTimelineEventSchema).max(30),
  candidates: z.array(RegressionCandidateSchema).max(3),
  facts: z.array(ClaimSchema).max(10),
  inferences: z.array(ClaimSchema).max(5),
  coverage: ForensicsCoverageSchema,
});
export type ForensicsResult = z.infer<typeof ForensicsResultSchema>;

export const RepositoryAnalysisSchema = z.object({
  summary: ClaimSchema,
  whatItDoes: ClaimSchema,
  audience: ClaimSchema,
  keyConcepts: z.array(ClaimSchema).max(5),
  architecture: z.array(ClaimSchema).max(5),
  quickStart: z.array(ClaimSchema).max(7),
  importantSections: z.array(z.object({
    title: z.string().min(1).max(160),
    explanation: z.string().min(1).max(500),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(6),
  unknowns: z.array(z.string().min(1).max(500)).max(6),
});
export type RepositoryAnalysis = z.infer<typeof RepositoryAnalysisSchema>;

export const LocalLaunchProposalSchema = z.object({
  status: z.enum(["available", "unsupported", "disabled"]),
  runtime: z.string().max(100).nullable(),
  commands: z.array(z.string().min(1).max(300)).max(6),
  reason: z.string().min(1).max(500),
  requiresApproval: z.literal(true),
});
export type LocalLaunchProposal = z.infer<typeof LocalLaunchProposalSchema>;

export const LocalLaunchStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "cloning", "installing", "starting", "running", "exited", "stopped", "error"]),
  phase: z.string().max(300),
  lines: z.array(z.string().max(1_200)).max(500),
  url: z.string().url().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type LocalLaunchStatus = z.infer<typeof LocalLaunchStatusSchema>;

export interface Source {
  id: string;
  kind: "issue" | "comment" | "repository" | "file" | "readme" | "timeline" | "pull_request" | "commit" | "workflow" | "deployment";
  url: string;
  label: string;
  excerpt: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  author?: string;
  createdAt?: string;
}
export interface IssueMetadata {
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
}
export interface RepositoryMetadata {
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  topics: string[];
  license: string | null;
}
export interface Coverage {
  commentsTotal: number;
  commentsRead: number;
  commentsTruncated: boolean;
  filesRead: number;
  pathsDiscovered: number;
  treeTruncated: boolean;
  codeSearch: "available" | "unavailable" | "not_used";
  limits: string[];
}
export interface Snapshot {
  id: string;
  commitSha: string;
  branch: string;
  fetchedAt: string;
}
export interface Activity { id: string; label: string; status: "running" | "done" | "error" }
export interface AgentError { code: string; message: string; retryable: boolean }
export interface RepoLensState {
  issue: IssueRef | null;
  repository: RepositoryRef | null;
  metadata: IssueMetadata | null;
  repositoryMetadata: RepositoryMetadata | null;
  runId: string | null;
  status: "idle" | "loading" | "complete" | "error" | "permission_denied" | "empty";
  phase: string;
  activities: Activity[];
  sources: Source[];
  coverage: Coverage;
  snapshot: Snapshot | null;
  analysisId: string | null;
  analysis: Analysis | null;
  solution: Solution | null;
  implementation: ImplementationDraft | null;
  forensicsStatus: "idle" | "loading" | "complete" | "error" | "permission_denied" | "empty";
  forensicsPhase: string;
  forensicsActivities: Activity[];
  forensics: ForensicsResult | null;
  forensicsError: AgentError | null;
  repositoryAnalysisId: string | null;
  repositoryAnalysis: RepositoryAnalysis | null;
  launchProposal: LocalLaunchProposal | null;
  error: AgentError | null;
}
export function initialState(issue: IssueRef | null = null): RepoLensState {
  return {
    issue, repository: null, metadata: null, repositoryMetadata: null, runId: null, status: "idle", phase: "", activities: [], sources: [],
    coverage: { commentsTotal: 0, commentsRead: 0, commentsTruncated: false, filesRead: 0, pathsDiscovered: 0, treeTruncated: false, codeSearch: "not_used", limits: [] },
    snapshot: null, analysisId: null, analysis: null, solution: null, implementation: null,
    forensicsStatus: "idle", forensicsPhase: "", forensicsActivities: [], forensics: null, forensicsError: null,
    repositoryAnalysisId: null, repositoryAnalysis: null, launchProposal: null, error: null,
  };
}
export function initialRepositoryState(repository: RepositoryRef): RepoLensState {
  return { ...initialState(), repository };
}
export interface HealthInfo { status: string; openaiConfigured: boolean; githubConfigured: boolean; localExecutionEnabled: boolean; model: string }
