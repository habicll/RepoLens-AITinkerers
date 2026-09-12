import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { z } from "zod";
import { initialState, IssueRefSchema, issueKey, parseIssueUrl, type IssueRef, type RepoLensState } from "../shared/contracts.js";
import { AppError } from "./errors.js";
import { GitHubRepository } from "./github.js";
import { openAICompletion, proposeSolution, understand, type Complete, type RepositoryReader, type UsageCounts } from "./analysis.js";
import { AnalysisSessionStore, analysisSessions } from "./session.js";

export interface RepoLensAgentConfig {
  openaiApiKey?: string;
  model: string;
  githubToken?: string;
  allowedRepos?: string[];
}
export interface RepoLensAgentDependencies {
  complete?: Complete;
  createRepository?: (issue: IssueRef, signal: AbortSignal, report: (label: string) => void) => RepositoryReader;
  sessions?: AnalysisSessionStore;
  timeoutMs?: number;
  logger?: (counts: UsageCounts & { durationMs: number; intent: string; success: boolean; errorCode?: string; errorStatus?: number; requestId?: string }) => void;
}
const CommandSchema = z.object({
  intent: z.enum(["understand", "propose_solution"]),
  issue: IssueRefSchema,
  analysisId: z.string().min(1).max(120).optional(),
}).strict();

function validIssue(value: IssueRef): IssueRef {
  const parsed = parseIssueUrl(value.url);
  if (!parsed || issueKey(parsed) !== issueKey(value)) throw new AppError("INVALID_ISSUE", "The issue URL does not match its repository and issue number.");
  return parsed;
}

function publicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  if (status === 401 || status === 403) return new AppError("OPENAI_AUTH", "The model service rejected the server API credentials. Check the server configuration.", 502);
  if (status === 429) return new AppError("MODEL_RATE_LIMIT", "The model service is temporarily rate limited. Please retry shortly.", 429, true);
  return new AppError("ANALYSIS_FAILED", "The analysis could not finish. Please retry; the server logs contain only run metrics.", 502, true);
}

export class RepoLensAgent extends AbstractAgent {
  constructor(private readonly config: RepoLensAgentConfig, private readonly dependencies: RepoLensAgentDependencies = {}) {
    super({ agentId: "repolens", description: "Understand the current GitHub issue with cited repository evidence", initialState: initialState() });
  }

  /** AG-UI's base clone does not preserve subclass fields. Keep services/config explicitly. */
  override clone(): RepoLensAgent {
    // The base copy also retains middleware/subscribers and protocol bookkeeping.
    return Object.assign(new RepoLensAgent(this.config, this.dependencies), super.clone());
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(observer => {
      const started = Date.now();
      const timeoutMs = this.dependencies.timeoutMs ?? 90_000;
      const controller = new AbortController();
      const counts: UsageCounts = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
      let timedOut = false;
      let successful = false;
      let intent = "invalid";
      let activitySequence = 0;
      let errorMetrics: { errorCode?: string; errorStatus?: number; requestId?: string } = {};
      let state: RepoLensState = { ...initialState(), runId: input.runId, status: "loading" };
      let repository: RepositoryReader | null = null;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const publish = () => {
        if (repository) state = { ...state, metadata: repository.metadata, snapshot: repository.snapshot, sources: [...repository.sources], coverage: structuredClone(repository.coverage) };
        if (!observer.closed) observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(state) });
      };
      const report = (label: string) => {
        state.phase = label;
        state.activities = [...state.activities.map(activity => ({ ...activity, status: "done" as const })),
          { id: `${input.runId}:${activitySequence++}`, label, status: "running" as const }].slice(-18);
        publish();
      };
      observer.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });

      const execute = async () => {
        const parsed = CommandSchema.safeParse(input.forwardedProps);
        if (!parsed.success) throw new AppError("INVALID_COMMAND", "Choose Understand or Propose a solution for a valid GitHub issue.");
        const command = parsed.data;
        intent = command.intent;
        const issue = validIssue(command.issue);
        state.issue = issue;
        if (this.config.allowedRepos?.length && !this.config.allowedRepos.some(repo => repo.toLowerCase() === `${issue.owner}/${issue.repo}`.toLowerCase())) {
          throw new AppError("REPOSITORY_NOT_ALLOWED", "This repository is not enabled on the demo server.", 403);
        }
        // Page context improves grounding; command fields remain explicitly validated.
        for (const context of input.context ?? []) {
          if (!/current github issue/i.test(context.description)) continue;
          let contextValue: unknown;
          try { contextValue = JSON.parse(context.value); } catch { throw new AppError("INVALID_CONTEXT", "The current page context could not be read. Reopen the panel."); }
          const contextRef = IssueRefSchema.safeParse(contextValue);
          if (!contextRef.success || issueKey(validIssue(contextRef.data)) !== issueKey(issue)) throw new AppError("STALE_CONTEXT", "The page changed. Run Understand for the currently open issue.", 409);
        }
        const sessions = this.dependencies.sessions ?? analysisSessions;
        const saved = command.intent === "propose_solution" ? sessions.get(command.analysisId, input.threadId, issue) : null;
        if (saved) state = { ...saved.state, issue, runId: input.runId, status: "loading", phase: "Preparing the solution", activities: [], solution: null, error: null };
        publish();
        if (!this.config.openaiApiKey && !this.dependencies.complete) throw new AppError("OPENAI_NOT_CONFIGURED", "Add OPENAI_API_KEY to the server environment, then retry Understand.", 503);
        const complete = this.dependencies.complete ?? openAICompletion(this.config.openaiApiKey!);

        if (saved?.state.analysis) {
          report("Proposing a solution from the saved commit and evidence");
          state.solution = await proposeSolution({ analysis: saved.state.analysis, evidence: saved.evidence, sources: saved.state.sources,
            model: this.config.model, complete, signal: controller.signal, counts });
        } else {
          const activeRepository: RepositoryReader = this.dependencies.createRepository?.(issue, controller.signal, report) ??
            new GitHubRepository(issue, { token: this.config.githubToken, allowedRepos: this.config.allowedRepos }, controller.signal, report);
          repository = activeRepository;
          report("Reading the issue and repository metadata");
          await activeRepository.bootstrap();
          publish();
          const result = await understand({ issue, repository: activeRepository, model: this.config.model, complete, signal: controller.signal, counts,
            report, deadline: started + timeoutMs });
          state.analysis = result.analysis;
          publish();
          const entry = sessions.save(input.threadId, issue, state, result.evidence);
          state.analysisId = entry.id;
        }
        controller.signal.throwIfAborted();
        successful = true;
        state.status = "complete";
        state.phase = intent === "understand" ? "Understanding complete" : "Solution proposed";
        state.activities = state.activities.map(activity => ({ ...activity, status: "done" }));
        state.error = null;
        publish();
        observer.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
        observer.complete();
      };
      void execute().catch(error => {
        if (observer.closed) return;
        const safe = timedOut ? new AppError("RUN_TIMEOUT", "The analysis reached its 90-second limit. Please retry.", 504, true) : publicError(error);
        const requestId = error && typeof error === "object" && "requestID" in error && typeof error.requestID === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(error.requestID) ? error.requestID : undefined;
        errorMetrics = { errorCode: safe.code, errorStatus: safe.status, ...(requestId ? { requestId } : {}) };
        state.status = safe.status === 403 ? "permission_denied" : "error";
        state.phase = "Could not finish";
        state.error = { code: safe.code, message: safe.message, retryable: safe.retryable };
        state.activities = state.activities.map(activity => ({ ...activity, status: activity.status === "running" ? "error" : activity.status }));
        publish();
        observer.next({ type: EventType.RUN_ERROR, message: safe.message, code: safe.code });
        observer.complete();
      }).finally(() => {
        clearTimeout(timeout);
        const metrics = { ...counts, durationMs: Date.now() - started, intent, success: successful, ...errorMetrics };
        if (this.dependencies.logger) this.dependencies.logger(metrics);
        else console.info("[repolens]", JSON.stringify(metrics));
      });
      return () => { clearTimeout(timeout); controller.abort(); };
    });
  }
}
