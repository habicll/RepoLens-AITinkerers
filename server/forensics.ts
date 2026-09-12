import { ForensicsResultSchema, type Analysis, type Claim, type ForensicsResult, type IssueMetadata, type IssueRef, type RegressionCandidate, type Source } from "../shared/contracts.js";
import { reasonForensics, type Complete, type UsageCounts } from "./analysis.js";
import type { ForensicsCommitDetail, ForensicsCommitSeed, ForensicsDeployment, ForensicsInspection, ForensicsSeed, ForensicsWorkflowRun } from "./forensics-github.js";
import { AppError } from "./errors.js";

export interface ForensicsReader {
  collect(issueCreatedAt: string, windowDays: number, report: (label: string) => void): Promise<ForensicsSeed>;
  inspect(commits: ForensicsCommitSeed[], deployments: ForensicsDeployment[], report: (label: string) => void): Promise<ForensicsInspection>;
}

interface CandidateDraft extends Omit<RegressionCandidate, "confidence" | "inference"> {
  score: number;
  inference: Claim | null;
}

const STOP_WORDS = new Set(["about", "after", "again", "also", "before", "being", "from", "have", "into", "issue", "that", "their", "there", "these", "this", "when", "where", "which", "with", "would", "dans", "avec", "pour", "une", "des", "les"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9_./-]+/g, " ").split(/\s+/).filter(word => word.length >= 3 && !STOP_WORDS.has(word)));
}
function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count++;
  return count;
}
function hoursBefore(timestamp: string, issueCreatedAt: string): number {
  return Math.max(0, (Date.parse(issueCreatedAt) - Date.parse(timestamp)) / 3_600_000);
}
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function uniqueSources(sources: Source[]): Source[] { return [...new Map(sources.map(source => [source.id, source])).values()]; }
function uniqueClaims(claims: Claim[], limit: number): Claim[] {
  return [...new Map(claims.map(claim => [`${claim.text}\0${claim.sourceIds.join(",")}`, claim])).values()].slice(0, limit);
}
function issueSource(sources: Source[], issue: IssueRef): Source {
  const source = sources.find(item => item.kind === "issue" && item.createdAt);
  if (!source?.createdAt) throw new AppError("FORENSICS_MISSING_DATE", "The issue creation time is unavailable; run Understand again.", 409);
  return source.url === issue.url ? source : { ...source, url: issue.url };
}
function compactIssueText(analysis: Analysis, metadata: IssueMetadata | null): string {
  return [metadata?.title, analysis.summary.text, ...analysis.facts.map(fact => fact.text), ...analysis.relevantContext.map(item => item.text),
    ...analysis.hypotheses.flatMap(item => [item.text, item.rationale]), ...analysis.relevantFiles.flatMap(file => [file.path, file.reason])].filter(Boolean).join(" ");
}

export function shortlistCommits(seed: ForensicsSeed, analysis: Analysis, metadata: IssueMetadata | null, issueCreatedAt: string): ForensicsCommitSeed[] {
  const issueTerms = tokens(compactIssueText(analysis, metadata));
  return seed.commits.map(commit => {
    const age = hoursBefore(commit.timestamp, issueCreatedAt);
    const proximity = age <= 6 ? 4 : age <= 24 ? 3 : age <= 72 ? 2 : 1;
    const semanticHint = Math.min(3, overlap(issueTerms, tokens(commit.message)));
    return { commit, score: proximity + semanticHint };
  }).sort((a, b) => b.score - a.score || Date.parse(b.commit.timestamp) - Date.parse(a.commit.timestamp)).slice(0, 6).map(item => item.commit);
}

function changedPathScore(files: string[], relevantPaths: string[], issueTerms: Set<string>): { score: number; paths: string[] } {
  const exact = files.filter(file => relevantPaths.includes(file));
  if (exact.length) return { score: 3, paths: exact };
  const related = files.filter(file => overlap(tokens(file), issueTerms) > 0).slice(0, 4);
  return { score: related.length ? Math.min(2, related.length) : 0, paths: related };
}

function buildCandidate(commit: ForensicsCommitDetail, seed: ForensicsSeed, deployments: ForensicsDeployment[], analysis: Analysis, metadata: IssueMetadata | null, issueCreatedAt: string): CandidateDraft {
  const issueTerms = tokens(compactIssueText(analysis, metadata));
  const relevantPaths = analysis.relevantFiles.map(file => file.path);
  const pull = commit.pull && Date.parse(commit.pull.mergedAt) <= Date.parse(issueCreatedAt) ? commit.pull : null;
  const timestamp = pull?.mergedAt ?? commit.timestamp;
  const sourceIds = unique([commit.sourceId, ...(pull ? [pull.sourceId] : [])]);
  const facts: Claim[] = [];
  const signals: CandidateDraft["signals"] = [];
  let score = 0;

  const age = hoursBefore(timestamp, issueCreatedAt);
  const temporalScore = age <= 6 ? 3 : age <= 24 ? 2 : age <= 72 ? 1 : 0;
  if (temporalScore) { score += temporalScore; signals.push("temporal"); }
  facts.push({ text: `${pull ? `PR #${pull.number} was merged` : `Commit ${commit.sha.slice(0, 7)} was authored`} ${age < 1 ? "less than one hour" : `${Math.round(age)} hours`} before the issue was created.`, sourceIds });
  if (pull) facts.push({ text: `PR #${pull.number}, “${pull.title},” contains commit ${commit.sha.slice(0, 7)}.`, sourceIds });

  const messageOverlap = overlap(issueTerms, tokens(`${commit.message} ${pull?.title ?? ""}`));
  if (messageOverlap) { score += Math.min(2, messageOverlap); signals.push("message"); }

  const pathMatch = changedPathScore(commit.files, relevantPaths, issueTerms);
  if (pathMatch.score) { score += pathMatch.score; signals.push("path"); }
  if (commit.files.length) facts.push({ text: `Associated commit ${commit.sha.slice(0, 7)} changed ${commit.files.length} inspected file${commit.files.length === 1 ? "" : "s"}${pathMatch.paths.length ? `, including ${pathMatch.paths.slice(0, 3).join(", ")}` : ""}.`, sourceIds: [commit.sourceId, ...(pull ? [pull.sourceId] : [])] });

  const referenced = seed.timeline.filter(event => event.commitSha === commit.sha || (pull && event.pullNumber === pull.number));
  if (referenced.length) {
    score += 2; signals.push("timeline");
    facts.push({ text: `${pull ? `PR #${pull.number}` : `Commit ${commit.sha.slice(0, 7)}`} is referenced in the issue timeline.`, sourceIds: unique([...sourceIds, ...referenced.map(event => event.sourceId)]).slice(0, 6) });
  }

  const workflows = seed.workflows.filter(run => run.headSha === commit.sha);
  const failures = workflows.filter(run => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion));
  if (failures.length) {
    score += 2; signals.push("ci");
    facts.push({ text: `${failures[0]!.name} concluded ${failures[0]!.conclusion} on commit ${commit.sha.slice(0, 7)}.`, sourceIds: [failures[0]!.sourceId, commit.sourceId] });
  }

  const relatedDeployments = deployments.filter(deployment => deployment.sha === commit.sha);
  if (relatedDeployments.length) {
    const successful = relatedDeployments.find(deployment => deployment.status === "success");
    score += successful ? 2 : 1; signals.push("deployment");
    const deployment = successful ?? relatedDeployments[0]!;
    facts.push({ text: `Deployment ${deployment.id} targeted ${deployment.environment} with commit ${commit.sha.slice(0, 7)}${deployment.status ? ` and reported ${deployment.status}` : ""}.`, sourceIds: [deployment.sourceId, commit.sourceId] });
  }

  return {
    id: pull ? `candidate:pr-${pull.number}` : `candidate:commit-${commit.sha.slice(0, 12)}`,
    type: pull ? "pull_request" : "commit", title: pull?.title ?? commit.message, url: pull?.url ?? commit.url,
    sha: commit.sha, number: pull?.number ?? null, timestamp, facts: facts.slice(0, 6), inference: null,
    changedFiles: commit.files.slice(0, 12), signals: unique(signals), score,
  };
}

function buildTimeline(issue: IssueRef, issueCreatedAt: string, issueSourceId: string, seed: ForensicsSeed, candidates: CandidateDraft[], deployments: ForensicsDeployment[]) {
  const candidateShas = new Set(candidates.map(candidate => candidate.sha));
  const candidatePulls = new Set(candidates.flatMap(candidate => candidate.number ? [candidate.number] : []));
  const items = [
    ...seed.timeline.filter(item => !item.commitSha || candidateShas.has(item.commitSha) || (item.pullNumber && candidatePulls.has(item.pullNumber))).map(item => ({
      id: item.id, timestamp: item.timestamp, type: item.pullNumber ? "pull_request" as const : item.commitSha ? "commit" as const : "issue" as const,
      title: item.title, description: `Issue timeline event: ${item.event}`, status: null, url: item.url, sourceIds: [item.sourceId],
    })),
    ...candidates.map(candidate => ({ id: `change:${candidate.id}`, timestamp: candidate.timestamp, type: candidate.type,
      title: candidate.type === "pull_request" ? `PR #${candidate.number} merged · ${candidate.title}` : `Commit ${candidate.sha.slice(0, 7)} · ${candidate.title}`,
      description: null, status: "candidate", url: candidate.url, sourceIds: candidate.facts[0]?.sourceIds.slice(0, 4) ?? [] })),
    ...seed.workflows.filter(run => candidateShas.has(run.headSha)).map(run => ({ id: `workflow:${run.id}`, timestamp: run.timestamp, type: "workflow" as const,
      title: `${run.name} · ${run.title}`, description: `Commit ${run.headSha.slice(0, 7)}`, status: run.conclusion ?? run.status, url: run.url, sourceIds: [run.sourceId] })),
    ...deployments.filter(item => candidateShas.has(item.sha)).map(item => ({ id: `deployment:${item.id}`, timestamp: item.timestamp, type: "deployment" as const,
      title: `Deployment to ${item.environment}`, description: `Commit ${item.sha.slice(0, 7)}`, status: item.status, url: item.url, sourceIds: [item.sourceId] })),
    { id: `issue-created:${issue.number}`, timestamp: issueCreatedAt, type: "issue" as const, title: `Issue #${issue.number} created`, description: "First report timestamp used by this investigation.", status: "reported", url: issue.url, sourceIds: [issueSourceId] },
  ];
  return [...new Map(items.map(item => [item.id, item])).values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-30);
}

export async function investigateIssue(options: {
  issue: IssueRef; metadata: IssueMetadata | null; analysis: Analysis; sources: Source[]; reader: ForensicsReader;
  windowDays: number; model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts; report: (label: string) => void;
}): Promise<{ result: ForensicsResult; sources: Source[] }> {
  const issueEvidence = issueSource(options.sources, options.issue);
  const issueCreatedAt = new Date(issueEvidence.createdAt!).toISOString();
  const seed = await options.reader.collect(issueCreatedAt, options.windowDays, options.report);
  const shortlist = shortlistCommits(seed, options.analysis, options.metadata, issueCreatedAt);
  const inspection = await options.reader.inspect(shortlist, seed.deployments, options.report);
  const allSources = uniqueSources([...options.sources, ...seed.sources, ...inspection.sources]);
  let drafts = [...inspection.commits.map(commit => buildCandidate(commit, seed, inspection.deployments, options.analysis, options.metadata, issueCreatedAt))
    .reduce((byId, candidate) => {
      const previous = byId.get(candidate.id);
      if (!previous) byId.set(candidate.id, candidate);
      else byId.set(candidate.id, { ...previous, score: Math.max(previous.score, candidate.score),
        facts: uniqueClaims([...previous.facts, ...candidate.facts], 6), changedFiles: unique([...previous.changedFiles, ...candidate.changedFiles]).slice(0, 12),
        signals: unique([...previous.signals, ...candidate.signals]), });
      return byId;
    }, new Map<string, CandidateDraft>()).values()];
  drafts.sort((a, b) => b.score - a.score || Date.parse(b.timestamp) - Date.parse(a.timestamp));

  if (drafts.length) {
    options.report("Comparing symptoms with the strongest evidence");
    const candidateRegistry = drafts.map(({ score, inference: _inference, ...candidate }) => ({ ...candidate, deterministicScore: score }));
    const reasoning = await reasonForensics({ model: options.model, complete: options.complete, signal: options.signal, counts: options.counts, sources: allSources,
      evidence: JSON.stringify({ issue: { ref: options.issue, metadata: options.metadata, analysis: options.analysis }, candidateRegistry,
        sourceRegistry: allSources.map(source => ({ id: source.id, kind: source.kind, label: source.label, path: source.path, createdAt: source.createdAt, excerpt: source.excerpt.slice(0, 1_500) })) }),
    });
    const assessmentByCandidate = new Map(reasoning.assessments.filter(item => drafts.some(draft => draft.id === item.candidateId)).map(item => [item.candidateId, item]));
    drafts = drafts.map(draft => {
      const assessment = assessmentByCandidate.get(draft.id);
      if (!assessment) return draft;
      const semanticScore = assessment.semanticRelevance === "high" ? 2 : assessment.semanticRelevance === "medium" ? 1 : 0;
      return { ...draft, score: draft.score + semanticScore,
        signals: semanticScore ? unique([...draft.signals, "semantic" as const]) : draft.signals,
        inference: { text: assessment.inference, sourceIds: assessment.sourceIds } };
    }).sort((a, b) => b.score - a.score || Date.parse(b.timestamp) - Date.parse(a.timestamp));

    const candidates: RegressionCandidate[] = drafts.slice(0, 3).map(({ score, ...candidate }) => ({ ...candidate, confidence: score >= 7 ? "high" : score >= 4 ? "medium" : "low" }));
    const strongest = candidates[0];
    const hasStrongCandidate = strongest && strongest.confidence !== "low";
    const result = ForensicsResultSchema.parse({
      status: strongest?.confidence === "high" ? "likely_regression" : strongest?.confidence === "medium" ? "possible_candidates" : "no_strong_evidence",
      summary: hasStrongCandidate ? reasoning.summary : { text: `No strong regression candidate was found in the ${options.windowDays}-day window.`, sourceIds: [issueEvidence.id] },
      mostLikelyCandidateId: hasStrongCandidate ? strongest.id : null,
      timeline: buildTimeline(options.issue, issueCreatedAt, issueEvidence.id, seed, drafts.slice(0, 3), inspection.deployments), candidates,
      facts: uniqueClaims(candidates.flatMap(candidate => candidate.facts), 10),
      inferences: uniqueClaims([...candidates.flatMap(candidate => candidate.inference ? [candidate.inference] : []), ...reasoning.inferences], 5),
      coverage: { ...seed.coverage, commitsInspected: inspection.commitsInspected, pullRequestsFound: inspection.pullRequestsFound,
        limits: [...new Set([...seed.coverage.limits, ...inspection.limits])].slice(0, 10) },
    });
    return { result, sources: allSources };
  }

  return { result: ForensicsResultSchema.parse({ status: "no_strong_evidence",
    summary: { text: `No commits were found in the ${options.windowDays}-day window before this issue was created.`, sourceIds: [issueEvidence.id] },
    mostLikelyCandidateId: null, timeline: buildTimeline(options.issue, issueCreatedAt, issueEvidence.id, seed, [], []), candidates: [], facts: [], inferences: [],
    coverage: { ...seed.coverage, commitsInspected: 0, pullRequestsFound: 0 },
  }), sources: allSources };
}
