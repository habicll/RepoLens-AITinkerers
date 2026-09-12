import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CopilotKitProvider, useAgent, useAgentContext, useCopilotKit } from "@copilotkit/react-core/v2";
import { AlertCircle, ArrowRight, ArrowUpRight, Check, CircleDot, FileCode2, Focus, Github, GitBranch, Link2, LoaderCircle, MessageSquare, RefreshCw, Search, ShieldCheck, Sparkles, Square } from "lucide-react";
import { initialState, issueKey, parseIssueUrl, type HealthInfo, type IssueRef, type RepoLensState } from "../shared/contracts";
import { AnalysisView, CoverageFooter, SolutionView } from "./components/AnalysisView";

export const API_URL = (import.meta.env.VITE_API_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
type Intent = "understand" | "propose_solution";
type HealthState = { kind: "checking" } | { kind: "ready"; data: HealthInfo } | { kind: "offline" };
const isExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;

function initialIssue(): IssueRef | null {
  return parseIssueUrl(new URLSearchParams(window.location.search).get("issue") || "");
}

export default function App() {
  const [issue, setIssue] = useState<IssueRef | null>(initialIssue);
  const [url, setUrl] = useState(() => initialIssue()?.url || "");
  const [inputError, setInputError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });
  const [healthVersion, setHealthVersion] = useState(0);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [request, setRequest] = useState<{ key: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setHealth({ kind: "checking" });
    fetch(`${API_URL}/api/health`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json() as HealthInfo;
      if (typeof data.openaiConfigured !== "boolean" || typeof data.githubConfigured !== "boolean") throw new Error("invalid health");
      if (active) setHealth({ kind: "ready", data });
    }).catch(() => { if (active) setHealth({ kind: "offline" }); }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [healthVersion]);

  useEffect(() => {
    if (!isExtension) return;
    let alive = true;
    let panelWindowId: number | undefined;
    let lastContextKey: string | null | undefined;
    let contextUpdates = 0;
    const applyContext = (value: { url?: unknown }) => {
      if (!alive) return;
      const next = typeof value.url === "string" ? parseIssueUrl(value.url) : null;
      const nextKey = next ? issueKey(next) : null;
      if (nextKey !== lastContextKey) {
        lastContextKey = nextKey;
        setIssue(next); setRequest(null); setBusy(false); setInputError(null);
      }
      setUrl(next?.url || "");
    };
    chrome.windows.getCurrent().then((window) => {
      panelWindowId = window.id;
      return chrome.runtime.sendMessage({ type: "GET_ISSUE_CONTEXT", windowId: panelWindowId });
    }).then((context) => { if (contextUpdates === 0) applyContext(context); }).catch(() => { if (alive) setInputError("The current GitHub page could not be detected. Reopen the panel to reconnect."); });
    const listener = (message: { type?: string; url?: unknown; windowId?: number }) => {
      if (message.type === "ISSUE_CONTEXT_CHANGED" && panelWindowId !== undefined && message.windowId === panelWindowId) { contextUpdates += 1; applyContext(message); }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => { alive = false; chrome.runtime.onMessage.removeListener(listener); };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = isExtension ? issue : parseIssueUrl(url);
    if (!next) { setInputError("Use a public GitHub issue URL, like https://github.com/owner/repo/issues/123."); return; }
    setInputError(null); setIssue(next); setUrl(next.url); setRequest({ key: issueKey(next), token: crypto.randomUUID() });
  };
  const configured = health.kind === "ready" && health.data.openaiConfigured;
  const disabled = busy || !configured || (isExtension && !issue);
  const resetConnection = useCallback(() => { setConnectionVersion((value) => value + 1); setBusy(false); }, []);

  return <div className={`app ${isExtension ? "is-extension" : ""} ${issue ? "has-issue" : ""}`}>
    <header className="site-header"><a className="brand" href={isExtension ? undefined : "/"} aria-label="RepoLens home"><span className="brand-mark"><Focus size={23} strokeWidth={1.8} /></span><span>RepoLens</span></a><span className="read-only"><ShieldCheck size={14} /> Read-only by design</span></header>
    <main className="main">
      <section className="hero"><div className="eyebrow"><span className="eyebrow-line" /> GITHUB ISSUE COMPANION</div><h1>Understand before<br className="desktop-break" /> you build<span className="accent-dot">.</span></h1><p>The discussion, the relevant code, the missing pieces.<br className="desktop-break" /> One clear starting point for your next issue.</p></section>
      <section className="issue-picker" aria-label="Choose a GitHub issue">
        <div className="picker-heading"><span className="small-label">{isExtension ? "CONNECTED TO YOUR TAB" : "START WITH A GITHUB ISSUE"}</span><Github size={16} /></div>
        <form onSubmit={submit}>
          {isExtension ? <div className="detected-issue"><CircleDot size={18} /><span>{issue ? <><strong>{issue.owner}/{issue.repo}</strong><span className="muted-copy"> Issue #{issue.number}</span></> : "Open a GitHub issue to get started"}</span>{issue && <a href={issue.url} target="_blank" rel="noreferrer noopener" aria-label="Open current issue on GitHub"><ArrowUpRight size={15} /></a>}</div> : <label className={`url-field ${inputError ? "invalid" : ""}`}><Link2 size={18} /><span className="sr-only">GitHub issue URL</span><input type="url" value={url} onChange={(event) => { setUrl(event.target.value); setInputError(null); }} placeholder="https://github.com/owner/repo/issues/123" spellCheck={false} autoComplete="off" aria-invalid={!!inputError} aria-describedby={inputError ? "issue-input-error" : undefined} /></label>}
          <button className="primary-button understand-button" type="submit" disabled={disabled}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}<span>{busy ? "Investigating…" : "Understand"}</span>{!busy && <ArrowRight size={16} />}</button>
        </form>
        {inputError ? <p id="issue-input-error" className="input-error" role="alert">{inputError}</p> : <p className="picker-note"><ShieldCheck size={12} /> Public repositories · Your code stays unchanged</p>}
      </section>
      {health.kind === "checking" && <div className="connection-note" role="status"><LoaderCircle size={14} className="spin" /> Checking the analysis service…</div>}
      {health.kind === "offline" && <Notice title="The analysis service is offline" description="Start the RepoLens server, then check the connection again." action="Check connection" onAction={() => setHealthVersion((value) => value + 1)} />}
      {health.kind === "ready" && !health.data.openaiConfigured && <Notice title="Analysis is not configured yet" description="Add an OpenAI API key to the server configuration, then check the connection again." action="Check connection" onAction={() => setHealthVersion((value) => value + 1)} />}
      {health.kind === "ready" && !health.data.githubConfigured && <div className="connection-note warning"><AlertCircle size={14} /> A GitHub token is not configured. Public API access may be limited.</div>}
      {issue && configured && <SessionProvider key={`${issueKey(issue)}:${connectionVersion}`} issue={issue} requestToken={request?.key === issueKey(issue) ? request.token : null} onBusy={setBusy} onReset={resetConnection} />}
      {!issue && <EmptyState extension={isExtension} />}
    </main>
    <footer className="site-footer"><span>Less digging. More understanding.</span><span className="powered-by">Built with <strong>CopilotKit</strong><span className="footer-dot">·</span> OpenAI</span></footer>
  </div>;
}

function SessionProvider({ issue, requestToken, onBusy, onReset }: { issue: IssueRef; requestToken: string | null; onBusy: (busy: boolean) => void; onReset: () => void }) {
  const [threadId] = useState(() => crypto.randomUUID());
  const [connectionError, setConnectionError] = useState(false);
  return <CopilotKitProvider runtimeUrl={`${API_URL}/api/copilotkit`} agentId="repolens" enableInspector={false} showDevConsole={false} onError={(event) => { if (event.code === "runtime_info_fetch_failed") { setConnectionError(true); onBusy(false); } }}>
    {connectionError ? <Notice title="The agent could not connect" description="The server is reachable, but its analysis connection is unavailable." action="Reconnect" onAction={onReset} /> : <AgentSession issue={issue} requestToken={requestToken} threadId={threadId} onBusy={onBusy} />}
  </CopilotKitProvider>;
}

function AgentSession({ issue, requestToken, threadId, onBusy }: { issue: IssueRef; requestToken: string | null; threadId: string; onBusy: (busy: boolean) => void }) {
  const { agent, isReady } = useAgent({ agentId: `repolens-${threadId}`, runtimeAgentId: "repolens", threadId });
  const { copilotkit } = useCopilotKit();
  const [working, setWorking] = useState<Intent | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [completed, setCompleted] = useState<RepoLensState | null>(null);
  const activeRun = useRef<string | null>(null);
  const lastRequest = useRef<string | null>(null);
  const mounted = useRef(true);
  useAgentContext({ description: "Current GitHub issue", value: issue });

  const remote = agent.state as Partial<RepoLensState>;
  const remoteIssue = remote.issue?.url ? parseIssueUrl(remote.issue.url) : null;
  const matched = !!remoteIssue && issueKey(remoteIssue) === issueKey(issue) && remote.runId === activeRun.current && activeRun.current !== null;
  const current: RepoLensState = matched ? { ...initialState(issue), ...remote } as RepoLensState : initialState(issue);
  const displayed = current.analysis ? current : completed;
  const busy = working !== null;
  const waiting = !!requestToken && lastRequest.current !== requestToken && !isReady;
  const failed = matched && (current.status === "error" || current.status === "permission_denied");

  useEffect(() => { onBusy(busy || waiting); }, [busy, waiting, onBusy]);
  useEffect(() => {
    if (!waiting) return;
    const timeout = window.setTimeout(() => {
      lastRequest.current = requestToken;
      setLocalError("The agent connection is taking too long. Check that the server is running, then click Understand to retry.");
      onBusy(false);
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [waiting, requestToken, onBusy]);
  useEffect(() => {
    if (matched && current.analysis && current.analysisId) setCompleted(current);
  }, [matched, remote]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRun.current = null; copilotkit.stopAgent({ agent }); onBusy(false); };
  }, [agent, copilotkit, onBusy]);

  const run = useCallback(async (intent: Intent) => {
    if (!isReady || working) return;
    const analysisId = completed?.analysisId || (agent.state as Partial<RepoLensState>).analysisId;
    if (intent === "propose_solution" && !analysisId) return;
    const runId = crypto.randomUUID();
    activeRun.current = runId; setWorking(intent); setStopped(false); setLocalError(null);
    if (intent === "understand") setCompleted(null);
    try {
      await copilotkit.runAgent({ agent, runId, forwardedProps: { intent, issue, ...(intent === "propose_solution" ? { analysisId } : {}) } });
    } catch (error) {
      if (mounted.current && activeRun.current === runId) setLocalError(error instanceof Error ? error.message : "The investigation was interrupted. Please try again.");
    } finally {
      if (mounted.current && activeRun.current === runId) setWorking(null);
    }
  }, [agent, completed?.analysisId, copilotkit, isReady, issue, working]);

  useEffect(() => {
    if (!requestToken || requestToken === lastRequest.current || !isReady || working) return;
    lastRequest.current = requestToken;
    void run("understand");
  }, [requestToken, isReady, working, run]);

  const stop = () => { activeRun.current = null; copilotkit.stopAgent({ agent }); setWorking(null); setStopped(true); };

  return <div className="workspace">
    {(busy || waiting) && <section className="progress-card" role="status" aria-live="polite"><div className="progress-top"><span className="progress-icon"><Search size={18} /></span><div><h2>{waiting ? "Connecting to your agent" : working === "propose_solution" ? "Working out the next steps" : "Following the evidence"}</h2><p>{current.phase || (waiting ? "Preparing the investigation…" : "Reading the issue and gathering useful context…")}</p></div>{busy && <button className="quiet-button" onClick={stop}><Square size={11} fill="currentColor" /> Stop</button>}</div>{current.activities.length > 0 && <ul className="activity-list">{current.activities.map((activity) => <li key={activity.id} className={activity.status}>{activity.status === "running" ? <LoaderCircle size={13} className="spin" /> : activity.status === "done" ? <Check size={13} /> : <AlertCircle size={13} />}<span>{activity.label}</span></li>)}</ul>}<div className="progress-track"><span /></div></section>}
    {stopped && <div className="connection-note"><Square size={12} /> Investigation stopped. You can start again when you are ready.</div>}
    {(localError || failed) && <Notice title={current.status === "permission_denied" ? "This issue is not accessible" : working === "propose_solution" || completed?.analysis ? "The solution could not be completed" : "The investigation could not be completed"} description={current.error?.message || localError || "Please try again."} />}
    {matched && current.status === "empty" && !displayed?.analysis && <Notice title="There is not enough context yet" description={current.error?.message || "No usable analysis could be produced from the available sources."} />}
    {displayed?.analysis && <>
      <div className="briefing-heading"><div><span className="eyebrow">ISSUE BRIEFING</span><h2>{displayed.metadata?.title || `Issue #${issue.number}`}</h2><a className="issue-reference" href={issue.url} target="_blank" rel="noreferrer noopener"><CircleDot size={14} /><span>{issue.owner}/{issue.repo} <strong>#{issue.number}</strong></span><ArrowUpRight size={13} /></a></div>{displayed.metadata?.state && <span className={`issue-state ${displayed.metadata.state}`}>{displayed.metadata.state}</span>}</div>
      {displayed.metadata && displayed.metadata.labels.length > 0 && <div className="issue-labels">{displayed.metadata.labels.slice(0, 5).map((label) => <span key={label}>{label}</span>)}</div>}
      <AnalysisView analysis={displayed.analysis} sources={displayed.sources} />
      {displayed.solution ? <SolutionView solution={displayed.solution} sources={displayed.sources} /> : <section className="next-step"><div><span className="next-step-icon"><GitBranch size={20} /></span><div><h2>Context first. A plan when you are ready.</h2><p>Turn these findings into an approach and concrete next steps.</p></div></div><button type="button" className="primary-button" onClick={() => void run("propose_solution")} disabled={busy || !isReady}>{working === "propose_solution" ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}Propose a solution<ArrowRight size={15} /></button></section>}
      <CoverageFooter coverage={displayed.coverage} snapshot={displayed.snapshot} />
    </>}
    {!displayed?.analysis && !busy && !waiting && !localError && !failed && !stopped && current.status !== "empty" && <section className="ready-card"><span className="ready-icon"><CircleDot size={25} /></span><h2>Your issue. A clearer starting point.</h2><p>Click Understand to follow the discussion, explore relevant code, and see what is already known.</p><a href={issue.url} target="_blank" rel="noreferrer noopener" className="text-link">{issue.owner}/{issue.repo} #{issue.number}<ArrowUpRight size={14} /></a></section>}
  </div>;
}

export function Notice({ title, description, action, onAction }: { title: string; description: string; action?: string; onAction?: () => void }) {
  return <section className="notice" role="alert"><AlertCircle size={19} /><div><h2>{title}</h2><p>{description}</p>{action && onAction && <button type="button" className="text-button" onClick={onAction}><RefreshCw size={13} />{action}</button>}</div></section>;
}

function EmptyState({ extension }: { extension: boolean }) {
  return <section className="empty-state" aria-label="How RepoLens works"><div className="empty-intro"><span className="small-label">{extension ? "YOUR NEXT ISSUE, IN FOCUS" : "FROM SCATTERED CONTEXT TO A CLEAR START"}</span><p>{extension ? "Navigate to an issue on GitHub. RepoLens will recognize it here automatically." : "Bring the right pieces together, without reading everything."}</p></div><div className="workflow"><article><span className="workflow-icon"><MessageSquare size={20} /></span><span className="workflow-index">01 / DISCUSSION</span><h2>Catch up, quickly.</h2><p>Understand the problem and what has already been tried.</p></article><article><span className="workflow-icon"><FileCode2 size={20} /></span><span className="workflow-index">02 / CODEBASE</span><h2>Find your bearings.</h2><p>Explore the files that matter, with sources you can inspect.</p></article><article><span className="workflow-icon"><GitBranch size={20} /></span><span className="workflow-index">03 / NEXT STEPS</span><h2>Move with context.</h2><p>Ask for a solution when you are ready to take the next step.</p></article></div><div className="empty-footnote"><span className="status-dot" /> Grounded in GitHub. Every finding links back to its source.</div></section>;
}
