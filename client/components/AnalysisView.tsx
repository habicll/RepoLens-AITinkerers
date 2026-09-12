import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, Copy, Download, FileCode2, FlaskConical, GitBranch, Info, Link2, MessageSquare, Terminal, X } from "lucide-react";
import type { Analysis, Claim, Coverage, ImplementationDraft, IssueRef, Snapshot, Solution, Source } from "../../shared/contracts";

const EvidenceContext = createContext<{ sources: Source[]; select: (source: Source) => void }>({ sources: [], select: () => undefined });

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function EvidenceScope({ sources, children }: { sources: Source[]; children: ReactNode }) {
  const [selected, setSelected] = useState<Source | null>(null);
  return <EvidenceContext.Provider value={{ sources, select: setSelected }}>
    {children}
    {selected && <SourcePreview source={selected} onClose={() => setSelected(null)} />}
  </EvidenceContext.Provider>;
}

function SourcePreview({ source, onClose }: { source: Source; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const url = safeSourceUrl(source.url);
  return <dialog ref={dialog} className="source-dialog" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="source-title">
    <div className="source-dialog-header">
      <div><span className="eyebrow">SOURCE EXCERPT</span><h2 id="source-title">{source.label}</h2></div>
      <button className="icon-button" onClick={onClose} aria-label="Close source"><X size={19} /></button>
    </div>
    <div className="source-meta">{source.kind === "file" || source.kind === "readme" ? <FileCode2 size={14} /> : <MessageSquare size={14} />}
      <span>{source.path || (source.author ? `@${source.author}` : source.kind)}{source.lineStart ? ` · lines ${source.lineStart}–${source.lineEnd || source.lineStart}` : ""}</span>
    </div>
    <pre className="source-excerpt">{source.excerpt || "No excerpt is available for this source."}</pre>
    {url && <a className="text-link source-outbound" href={url} target="_blank" rel="noreferrer noopener">View on GitHub <ArrowUpRight size={15} /></a>}
  </dialog>;
}

export function SourceChips({ ids }: { ids: string[] }) {
  const { sources, select } = useContext(EvidenceContext);
  const byId = new Map(sources.map((source) => [source.id, source]));
  return <span className="source-chips">{[...new Set(ids)].map((id) => {
    const source = byId.get(id);
    if (!source) return null;
    const label = source.path?.split("/").pop() || (source.kind === "comment" ? (source.author ? `@${source.author}` : "Comment") : source.kind === "issue" ? "Issue" : "README");
    return <button key={id} type="button" className="source-chip" onClick={() => select(source)} title={`Read source: ${source.label}`} aria-label={`Read source: ${source.label}`}><Link2 size={11} /><span>{label}</span></button>;
  })}</span>;
}

function ClaimText({ claim, className = "" }: { claim: Claim; className?: string }) {
  return <div className={`claim ${className}`}><p>{claim.text}</p><SourceChips ids={claim.sourceIds} /></div>;
}

function Detail({ title, icon, badge, children }: { title: string; icon: ReactNode; badge?: string; children: ReactNode }) {
  return <details className="detail"><summary><span className="detail-icon">{icon}</span><span>{title}</span>{badge && <span className={`detail-badge ${badge === "Inferred" ? "amber" : ""}`}>{badge}</span>}<ChevronDown size={16} className="detail-chevron" /></summary><div className="detail-body">{children}</div></details>;
}

export function AnalysisView({ analysis, sources }: { analysis: Analysis; sources: Source[] }) {
  return <EvidenceScope sources={sources}>
    <div className="analysis-grid">
      <section className="result-card summary-card" aria-labelledby="summary-heading">
        <div className="section-heading"><span className="section-marker">01</span><h2 id="summary-heading">The problem</h2><span className="verified-label"><Check size={12} /> Source-backed</span></div>
        <ClaimText claim={analysis.summary} className="summary-claim" />
        {analysis.facts.length > 0 && <div className="facts"><div className="small-label">FOUND IN GITHUB</div>{analysis.facts.map((fact, index) => <div key={index} className="fact"><span className="fact-dot" /><ClaimText claim={fact} /></div>)}</div>}
      </section>
      <section className="result-card attempts-card" aria-labelledby="attempts-heading">
        <div className="section-heading"><span className="section-marker">02</span><h2 id="attempts-heading">Already tried</h2></div>
        {analysis.alreadyTried.length ? <div className="attempts">{analysis.alreadyTried.map((attempt, index) => <article className="attempt" key={index}>
          <span className={`attempt-dot ${attempt.status}`} />
          <div><span className={`tiny-label ${attempt.status === "suggested" ? "muted" : ""}`}>{attempt.status === "suggested" ? "Suggested · not confirmed as tried" : "Documented attempt"}</span><h3>{attempt.action}</h3><p>{attempt.outcome}</p><SourceChips ids={attempt.sourceIds} /></div>
        </article>)}</div> : <div className="section-empty"><MessageSquare size={20} /><p>No attempts were documented in the sources reviewed.</p></div>}
      </section>
      <section className="result-card files-card" aria-labelledby="files-heading">
        <div className="section-heading"><span className="section-marker">03</span><h2 id="files-heading">Where to look</h2></div>
        {analysis.relevantFiles.length ? <div className="file-list">{analysis.relevantFiles.map((file, index) => <article className="file-item" key={`${file.path}-${index}`}>
          <span className="file-icon"><FileCode2 size={18} /></span><div><h3><code>{file.path}</code></h3><p>{file.reason}</p><SourceChips ids={file.sourceIds} /></div>
        </article>)}</div> : <div className="section-empty"><FileCode2 size={20} /><p>No relevant code was verified in this investigation.</p></div>}
      </section>
    </div>
    {analysis.hypotheses.length > 0 && <section className="hypotheses" aria-label="Working hypotheses">{analysis.hypotheses.map((hypothesis, index) => <article className="hypothesis" key={index}>
      <div className="hypothesis-label"><CircleHelp size={15} /><span>Working hypothesis</span><span className="confidence">{hypothesis.confidence} confidence · inferred</span></div><h3>{hypothesis.text}</h3><p>{hypothesis.rationale}</p><SourceChips ids={hypothesis.sourceIds} />
      {hypothesis.unknowns.length > 0 && <div className="hypothesis-unknown"><strong>Still unknown</strong><ul>{hypothesis.unknowns.map((unknown, i) => <li key={i}>{unknown}</li>)}</ul></div>}
    </article>)}</section>}
    <section className="details-card" aria-label="Investigation details">
      <div className="details-header"><h2>A little more context</h2><span>Open what you need</span></div>
      <Detail title="How to reproduce" icon={<FlaskConical size={17} />} badge={analysis.reproduction.status === "documented" ? "Documented" : analysis.reproduction.status === "inferred" ? "Inferred" : "Not documented"}>
        <p className="inline-note"><Info size={15} /><span>{analysis.reproduction.status === "inferred" && "These steps are inferred from the sources. "}RepoLens has not executed any reproduction steps.</span></p>
        {analysis.reproduction.steps.length ? <ol className="claim-list numbered">{analysis.reproduction.steps.map((step, index) => <li key={index}><ClaimText claim={step} /></li>)}</ol> : <p className="muted-copy">The sources do not provide enough information to reproduce this issue.</p>}
        {analysis.reproduction.expected && <div className="reproduction-outcome"><span className="small-label">EXPECTED</span><ClaimText claim={analysis.reproduction.expected} /></div>}
        {analysis.reproduction.actual && <div className="reproduction-outcome"><span className="small-label">ACTUAL</span><ClaimText claim={analysis.reproduction.actual} /></div>}
      </Detail>
      <Detail title="How to run the project" icon={<Terminal size={17} />} badge={analysis.howToRun.length ? undefined : "Not documented"}>
        {analysis.howToRun.length ? <ol className="claim-list numbered">{analysis.howToRun.map((claim, index) => <li key={index}><ClaimText claim={claim} /></li>)}</ol> : <p className="muted-copy">No verified setup instructions were found in the sources reviewed.</p>}
      </Detail>
      <Detail title="Relevant repository context" icon={<BookOpen size={17} />}>
        {analysis.relevantContext.length ? <div className="claim-list">{analysis.relevantContext.map((claim, index) => <ClaimText key={index} claim={claim} />)}</div> : <p className="muted-copy">No additional repository context was established.</p>}
      </Detail>
      <Detail title="What is still unknown" icon={<CircleHelp size={17} />} badge={String(analysis.unknowns.length)}>
        {analysis.unknowns.length ? <ul className="plain-list">{analysis.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p className="muted-copy">No additional gaps were identified in this analysis. The proposed behavior has not been tested.</p>}
      </Detail>
    </section>
  </EvidenceScope>;
}

export function SolutionView({ solution, sources }: { solution: Solution; sources: Source[] }) {
  return <EvidenceScope sources={sources}><section className="solution-card" aria-labelledby="solution-heading">
    <div className="solution-heading"><span className="solution-icon"><GitBranch size={19} /></span><div><span className="eyebrow">YOUR NEXT STEP</span><h2 id="solution-heading">Proposed solution</h2></div><span className="detail-badge">Not implemented</span></div>
    {solution.status === "needs_more_information" && <p className="inline-note"><Info size={15} /> More information is needed before this approach can be confirmed.</p>}
    <ClaimText claim={solution.approach} className="solution-approach" />
    {solution.assumptions.length > 0 && <div className="solution-notes"><h3>Assumptions</h3><ul className="plain-list">{solution.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    {solution.steps.length > 0 && <div className="plan"><h3>Implementation plan</h3>{solution.steps.map((step, index) => <article className="plan-step" key={index}><span className="step-number">{index + 1}</span><div><h4>{step.title}</h4><p>{step.detail}</p>{step.files.length > 0 && <div className="plan-files">{step.files.map((file) => <code key={file}>{file}</code>)}</div>}<p className="validation"><Check size={14} /><span><strong>Validate:</strong> {step.validation}</span></p><SourceChips ids={step.sourceIds} /></div></article>)}</div>}
    {solution.risks.length > 0 && <div className="solution-notes"><h3>Risks to check</h3><ul className="plain-list">{solution.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    {solution.openQuestions.length > 0 && <div className="solution-notes"><h3>Open questions</h3><ul className="plain-list">{solution.openQuestions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
  </section></EvidenceScope>;
}

export function ImplementationView({ implementation, sources, issue }: { implementation: ImplementationDraft; sources: Source[]; issue: IssueRef }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const copyPatch = async () => {
    try {
      await navigator.clipboard.writeText(implementation.patch);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };
  const downloadPatch = () => {
    const href = URL.createObjectURL(new Blob([implementation.patch], { type: "text/x-diff;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `${issue.owner}-${issue.repo}-${issue.number}-repolens.patch`;
    link.click();
    URL.revokeObjectURL(href);
  };
  return <EvidenceScope sources={sources}><section className="implementation-card" aria-labelledby="implementation-heading">
    <div className="implementation-heading"><div><span className="eyebrow">IMPLEMENTATION DRAFT</span><h2 id="implementation-heading">Review the proposed patch</h2></div><span className="detail-badge">Not applied · Not tested</span></div>
    <ClaimText claim={implementation.summary} className="implementation-summary" />
    {implementation.status === "needs_more_information" ? <p className="inline-note"><Info size={15} /> The inspected excerpts are not sufficient to draft an exact patch.</p> : <>
      <div className="implementation-files">{implementation.files.map(file => <article key={file.path}><code>{file.path}</code><p>{file.explanation}</p><SourceChips ids={file.sourceIds} /></article>)}</div>
      <div className="patch-toolbar"><span>Unified diff</span><div><button type="button" onClick={() => void copyPatch()}><Copy size={13} />{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}</button><button type="button" onClick={downloadPatch}><Download size={13} />Download</button></div></div>
      <pre className="patch-preview"><code>{implementation.patch}</code></pre>
      {implementation.validationCommands.length > 0 && <div className="implementation-notes"><h3>Suggested validation · not executed</h3>{implementation.validationCommands.map(command => <code key={command}>{command}</code>)}</div>}
    </>}
    {implementation.notes.length > 0 && <div className="implementation-notes"><h3>Before applying</h3><ul className="plain-list">{implementation.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}
  </section></EvidenceScope>;
}

export function CoverageFooter({ coverage, snapshot }: { coverage: Coverage; snapshot: Snapshot | null }) {
  return <div className="coverage"><div className="coverage-stats"><span><MessageSquare size={13} /> {coverage.commentsRead}/{coverage.commentsTotal} comments</span><span><FileCode2 size={13} /> {coverage.filesRead} files read</span>{snapshot && <span title={`${snapshot.branch} · ${snapshot.commitSha}`}><GitBranch size={13} /> {snapshot.commitSha.slice(0, 7)}</span>}</div>
    {(coverage.limits.length > 0 || coverage.commentsTruncated || coverage.treeTruncated) && <details className="coverage-limits"><summary><Info size={13} /> Context limits <ChevronDown size={12} /></summary><ul>{coverage.commentsTruncated && <li>Some comments were not included in full.</li>}{coverage.treeTruncated && <li>The repository tree was limited.</li>}{coverage.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>}
  </div>;
}
