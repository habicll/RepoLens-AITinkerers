import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, BookOpen, Check, CircleHelp, Copy, FileCode2, LoaderCircle, Play, Square, Terminal } from "lucide-react";
import type { Claim, LocalLaunchProposal, LocalLaunchStatus, RepositoryAnalysis, RepositoryMetadata, RepositoryRef, Snapshot, Source } from "../../shared/contracts";
import { EvidenceScope, SourceChips } from "./AnalysisView";

function ClaimBlock({ claim }: { claim: Claim }) {
  return <div className="claim"><p>{claim.text}</p><SourceChips ids={claim.sourceIds} /></div>;
}

async function copyText(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); return; }
  catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }
}

export function RepositoryView({ analysis, sources, metadata, repository, snapshot, commands }: {
  analysis: RepositoryAnalysis; sources: Source[]; metadata: RepositoryMetadata | null; repository: RepositoryRef; snapshot: Snapshot | null; commands: string[];
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetCopy = useRef<number | null>(null);
  useEffect(() => () => { if (resetCopy.current) window.clearTimeout(resetCopy.current); }, []);
  const copyCommands = async () => {
    try { await copyText(commands.join("\n")); setCopyState("copied"); }
    catch { setCopyState("failed"); }
    if (resetCopy.current) window.clearTimeout(resetCopy.current);
    resetCopy.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };
  const commandSourceIds = sources.filter(source => source.kind === "readme" || source.path === "package.json").map(source => source.id);
  return <EvidenceScope sources={sources}><>
    <div className="briefing-heading repository-heading"><div><span className="eyebrow">REPOSITORY BRIEFING</span><h2>{metadata?.name || repository.repo}</h2><a className="issue-reference" href={repository.url} target="_blank" rel="noreferrer noopener"><BookOpen size={14} /><span>{repository.owner}/{repository.repo}</span><ArrowUpRight size={13} /></a></div>{metadata?.language && <span className="issue-state open">{metadata.language}</span>}</div>
    <section className="result-card repository-summary" aria-labelledby="repository-summary-heading">
      <div className="section-heading"><span className="section-marker">01</span><h2 id="repository-summary-heading">What this project is</h2><span className="verified-label"><Check size={12} /> Source-backed</span></div>
      <ClaimBlock claim={analysis.summary} />
      <div className="repository-purpose"><div><span className="small-label">WHAT IT DOES</span><ClaimBlock claim={analysis.whatItDoes} /></div><div><span className="small-label">WHO IT IS FOR</span><ClaimBlock claim={analysis.audience} /></div></div>
    </section>
    {commands.length > 0 && <section className="run-commands" aria-labelledby="run-commands-heading"><div className="run-commands-heading"><div><span className="eyebrow">COPY &amp; RUN</span><h2 id="run-commands-heading">Paste this into your terminal</h2></div><button type="button" onClick={() => void copyCommands()}><Copy size={13} />{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}</button></div><pre><code>{commands.join("\n")}</code></pre>{commandSourceIds.length > 0 && <div className="run-commands-sources"><span>Derived from the pinned manifest and README</span><SourceChips ids={commandSourceIds} /></div>}</section>}
    <div className="repository-grid">
      <section className="result-card"><div className="section-heading"><span className="section-marker">02</span><h2>Concepts to know</h2></div>{analysis.keyConcepts.length ? <div className="repository-list">{analysis.keyConcepts.map((claim, index) => <article key={index}><span>{index + 1}</span><ClaimBlock claim={claim} /></article>)}</div> : <p className="muted-copy">The inspected README does not establish distinct project concepts.</p>}</section>
      <section className="result-card"><div className="section-heading"><span className="section-marker">03</span><h2>How it is organized</h2></div>{analysis.architecture.length ? <div className="repository-list">{analysis.architecture.map((claim, index) => <article key={index}><FileCode2 size={15} /><ClaimBlock claim={claim} /></article>)}</div> : <p className="muted-copy">No architecture was explicitly documented in the inspected sources.</p>}</section>
    </div>
    <section className="details-card repository-details">
      <details className="detail"><summary><span className="detail-icon"><Terminal size={17} /></span><span>Setup details from the README</span><span className="detail-badge">Not executed</span></summary><div className="detail-body">{analysis.quickStart.length ? <ol className="claim-list numbered">{analysis.quickStart.map((claim, index) => <li key={index}><ClaimBlock claim={claim} /></li>)}</ol> : <p className="muted-copy">No verified setup instructions were found in the README or manifest.</p>}</div></details>
      <details className="detail"><summary><span className="detail-icon"><BookOpen size={17} /></span><span>README sections worth reading</span><span className="detail-badge">{analysis.importantSections.length}</span></summary><div className="detail-body"><div className="repository-sections">{analysis.importantSections.map((section, index) => <article key={index}><h3>{section.title}</h3><p>{section.explanation}</p><SourceChips ids={section.sourceIds} /></article>)}</div></div></details>
      <details className="detail"><summary><span className="detail-icon"><CircleHelp size={17} /></span><span>What is still unknown</span><span className="detail-badge">{analysis.unknowns.length}</span></summary><div className="detail-body">{analysis.unknowns.length ? <ul className="plain-list">{analysis.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p className="muted-copy">No additional gaps were identified in the inspected project overview.</p>}</div></details>
    </section>
    {snapshot && <p className="repository-snapshot">Briefing pinned to <code>{snapshot.commitSha.slice(0, 7)}</code> on {snapshot.branch}.</p>}
  </></EvidenceScope>;
}

const terminalDone = new Set<LocalLaunchStatus["status"]>(["exited", "stopped", "error"]);

export function LocalLaunchControl({ proposal, analysisId, threadId, apiUrl }: {
  proposal: LocalLaunchProposal; analysisId: string; threadId: string; apiUrl: string;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [approved, setApproved] = useState(false);
  const [run, setRun] = useState<LocalLaunchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const output = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!run || terminalDone.has(run.status)) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      fetch(`${apiUrl}/api/local-launch/${run.id}`, { signal: controller.signal }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message || "Unable to read the local process.");
        setRun(body as LocalLaunchStatus);
      }).catch(fetchError => { if (!controller.signal.aborted) setError(fetchError instanceof Error ? fetchError.message : "Unable to read the local process."); });
    }, 1000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [apiUrl, run?.id, run?.status]);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [run?.lines.length]);

  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message || "The local project could not be controlled.");
    return value as LocalLaunchStatus;
  };
  const start = async () => {
    setError(null);
    try { setRun(await request("/api/local-launch/start", { repositoryAnalysisId: analysisId, threadId, approval: "RUN_UNTRUSTED_REPOSITORY_CODE" })); }
    catch (startError) { setError(startError instanceof Error ? startError.message : "The local project could not be started."); }
  };
  const stop = async () => {
    if (!run) return;
    setError(null);
    try { setRun(await request(`/api/local-launch/${run.id}/stop`)); }
    catch (stopError) { setError(stopError instanceof Error ? stopError.message : "The local project could not be stopped."); }
  };

  return <section className="local-launch" aria-labelledby="local-launch-heading">
    <div className="local-launch-heading"><span className="terminal-icon"><Terminal size={19} /></span><div><span className="eyebrow">OPTIONAL LOCAL RUN</span><h2 id="local-launch-heading">Launch this project on this computer</h2></div>{run && <span className={`run-status ${run.status}`}>{run.status}</span>}</div>
    <p>{proposal.reason}</p>
    {proposal.status === "available" && !reviewing && !run && <button className="primary-button" type="button" onClick={() => setReviewing(true)}><Play size={15} />Review and launch</button>}
    {proposal.status === "disabled" && <p className="inline-note"><AlertTriangle size={15} /> The server owner must enable local execution before this button becomes available.</p>}
    {proposal.status === "unsupported" && <p className="inline-note"><AlertTriangle size={15} /> RepoLens will not guess a command or execute README text.</p>}
    {reviewing && !run && <div className="execution-consent"><p><AlertTriangle size={16} /> This will download the repository, install dependencies, and execute its npm script with your user permissions. Repository code is untrusted.</p><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> I reviewed the commands above and approve this local run.</label><div><button className="quiet-button" type="button" onClick={() => { setReviewing(false); setApproved(false); }}>Cancel</button><button className="primary-button" type="button" disabled={!approved} onClick={() => void start()}><Play size={14} />Launch project</button></div></div>}
    {run && <div className="terminal-panel"><div className="terminal-toolbar"><span><span className={`terminal-dot ${run.status}`} /> {run.phase}</span>{!terminalDone.has(run.status) && <button type="button" onClick={() => void stop()}><Square size={11} fill="currentColor" /> Stop</button>}</div><pre ref={output} aria-live="polite">{run.lines.length ? run.lines.join("\n") : "Waiting for process output…"}</pre>{run.url && <a className="primary-button terminal-open" href={run.url} target="_blank" rel="noreferrer noopener">Open {new URL(run.url).host}<ArrowUpRight size={14} /></a>}</div>}
    {error && <p className="input-error" role="alert">{error}</p>}
    {run && !terminalDone.has(run.status) && <p className="terminal-wait"><LoaderCircle size={13} className="spin" /> Live output from the controlled local process</p>}
  </section>;
}
