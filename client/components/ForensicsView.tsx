import { AlertTriangle, ArrowLeft, ArrowUpRight, Check, Clock3, FileCode2, GitCommitHorizontal, GitPullRequest, SearchCode, ShieldQuestion } from "lucide-react";
import type { ForensicsResult, RegressionCandidate, Source } from "../../shared/contracts";
import { ClaimText, EvidenceScope, SourceChips } from "./AnalysisView";

function githubUrl(value: string, suffix = ""): string | undefined {
  try {
    const url = new URL(`${value}${suffix}`);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function CandidateCard({ candidate, primary = false }: { candidate: RegressionCandidate; primary?: boolean }) {
  const Icon = candidate.type === "pull_request" ? GitPullRequest : GitCommitHorizontal;
  const url = githubUrl(candidate.url);
  const filesUrl = githubUrl(candidate.url, candidate.type === "pull_request" ? "/files" : "");
  return <article className={`forensics-candidate ${primary ? "primary" : ""}`}>
    <div className="candidate-top"><span className="candidate-icon"><Icon size={18} /></span><div><span className="tiny-label">{candidate.type === "pull_request" ? `PULL REQUEST #${candidate.number}` : `COMMIT ${candidate.sha.slice(0, 7)}`}</span><h3>{candidate.title}</h3></div><span className={`confidence-badge ${candidate.confidence}`}>{candidate.confidence}</span></div>
    {candidate.inference && <div className="candidate-inference"><ShieldQuestion size={15} /><div><span>Inference</span><p>{candidate.inference.text}</p><SourceChips ids={candidate.inference.sourceIds} /></div></div>}
    <div className="candidate-signals">{candidate.signals.map(signal => <span key={signal}>{signal}</span>)}</div>
    {candidate.changedFiles.length > 0 && <div className="candidate-files"><span className="small-label">CHANGED FILES</span>{candidate.changedFiles.slice(0, 6).map(path => <code key={path}>{path}</code>)}</div>}
    <div className="candidate-actions">{url && <a href={url} target="_blank" rel="noreferrer noopener">Open {candidate.type === "pull_request" ? `PR #${candidate.number}` : "commit"}<ArrowUpRight size={13} /></a>}{filesUrl && candidate.changedFiles.length > 0 && <a href={filesUrl} target="_blank" rel="noreferrer noopener">View changed files<FileCode2 size={13} /></a>}</div>
  </article>;
}

export function ForensicsView({ result, sources, onBack }: { result: ForensicsResult; sources: Source[]; onBack: () => void }) {
  const mostLikely = result.candidates.find(candidate => candidate.id === result.mostLikelyCandidateId) ?? null;
  const others = result.candidates.filter(candidate => candidate.id !== mostLikely?.id);
  return <EvidenceScope sources={sources}><div className="forensics-view">
    <button type="button" className="forensics-back" onClick={onBack}><ArrowLeft size={15} />Back to overview</button>
    <header className="forensics-header"><div><span className="eyebrow">ISSUE FORENSICS</span><h2>{result.status === "likely_regression" ? "Likely regression detected" : result.status === "possible_candidates" ? "Possible regressions found" : "No strong evidence found"}</h2></div><span className={`forensics-verdict ${result.status}`}><SearchCode size={14} />Evidence reconstructed</span></header>
    <section className="forensics-summary"><span className="section-marker">01</span><div><span className="small-label">INVESTIGATION SUMMARY</span><ClaimText claim={result.summary} /></div></section>

    {mostLikely ? <section className="forensics-section"><div className="forensics-section-title"><div><span className="section-marker">02</span><div><span className="small-label">MOST LIKELY CULPRIT</span><h2>Strongest candidate</h2></div></div><span className="inference-label"><ShieldQuestion size={13} />Suspected, not proven</span></div><CandidateCard candidate={mostLikely} primary /></section>
      : <section className="forensics-empty"><AlertTriangle size={22} /><div><h2>No strong regression candidate</h2><p>The available changes do not support naming a likely culprit. IssueLens will not invent one.</p></div></section>}

    {others.length > 0 && <section className="forensics-section"><div className="forensics-section-title"><div><span className="section-marker">03</span><div><span className="small-label">CANDIDATE RANKING</span><h2>Other possible regressions</h2></div></div></div><div className="candidate-list">{others.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} />)}</div></section>}

    <section className="forensics-section"><div className="forensics-section-title"><div><span className="section-marker">04</span><div><span className="small-label">RECONSTRUCTED EVENTS</span><h2>Timeline</h2></div></div><span>{result.coverage.windowDays}-day window</span></div>
      <ol className="forensics-timeline">{result.timeline.map(event => { const url = githubUrl(event.url); return <li key={event.id}><span className={`timeline-node ${event.type}`} /> <time dateTime={event.timestamp}>{timeLabel(event.timestamp)}</time><div><span className="timeline-type">{event.type.replace("_", " ")}</span><h3>{event.title}</h3>{event.description && <p>{event.description}</p>}<SourceChips ids={event.sourceIds} />{url && <a href={url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${event.title} on GitHub`}><ArrowUpRight size={13} /></a>}</div>{event.status && <span className={`timeline-status ${event.status}`}>{event.status}</span>}</li>})}</ol>
    </section>

    <div className="forensics-evidence-grid">
      <section className="forensics-section facts-panel"><div className="forensics-section-title"><div><Check size={17} /><div><span className="small-label">GITHUB DATA</span><h2>Facts</h2></div></div></div>{result.facts.length ? <div className="forensics-claims">{result.facts.map((fact, index) => <ClaimText key={index} claim={fact} />)}</div> : <p className="muted-copy">No candidate facts were established.</p>}</section>
      <section className="forensics-section inference-panel"><div className="forensics-section-title"><div><ShieldQuestion size={17} /><div><span className="small-label">MODEL REASONING</span><h2>Inferences</h2></div></div></div>{result.inferences.length ? <div className="forensics-claims">{result.inferences.map((inference, index) => <ClaimText key={index} claim={inference} />)}</div> : <p className="muted-copy">No supported causal inference was made.</p>}</section>
    </div>
    <footer className="forensics-coverage"><Clock3 size={14} /><span>{result.coverage.commitsConsidered} commits considered · {result.coverage.commitsInspected} inspected · {result.coverage.pullRequestsFound} linked PRs</span><span>Actions: {result.coverage.actions.replace("_", " ")} · Deployments: {result.coverage.deployments.replace("_", " ")}</span>{result.coverage.limits.length > 0 && <details><summary>Coverage limits</summary><ul>{result.coverage.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>}</footer>
  </div></EvidenceScope>;
}
