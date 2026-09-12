import { randomUUID } from "node:crypto";
import { issueKey, type IssueRef, type RepoLensState } from "../shared/contracts.js";
import { AppError } from "./errors.js";

export interface AnalysisSession {
  id: string;
  threadId: string;
  issueKey: string;
  state: RepoLensState;
  evidence: string;
  createdAt: number;
}

/** The browser receives an opaque ID, never authority over the saved evidence. */
export class AnalysisSessionStore {
  private readonly entries = new Map<string, AnalysisSession>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 15 * 60_000, private readonly maximum = 10) {}

  save(threadId: string, issue: IssueRef, state: RepoLensState, evidence: string): AnalysisSession {
    this.prune();
    for (const [id, entry] of this.entries) {
      if (entry.threadId === threadId && entry.issueKey === issueKey(issue)) this.entries.delete(id);
    }
    while (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID();
    const entry: AnalysisSession = { id, threadId, issueKey: issueKey(issue), state: structuredClone({ ...state, analysisId: id }), evidence, createdAt: this.now() };
    this.entries.set(id, entry);
    return structuredClone(entry);
  }

  get(id: string | undefined, threadId: string, issue: IssueRef): AnalysisSession {
    this.prune();
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry || entry.threadId !== threadId || entry.issueKey !== issueKey(issue)) {
      throw new AppError("ANALYSIS_REQUIRED", "Understand this issue first. Its saved analysis may have expired; run Understand again.", 409);
    }
    return structuredClone(entry);
  }

  updateState(id: string, threadId: string, issue: IssueRef, state: RepoLensState): AnalysisSession {
    const existing = this.get(id, threadId, issue);
    const updated = { ...existing, state: structuredClone({ ...state, analysisId: id }) };
    this.entries.set(id, updated);
    return structuredClone(updated);
  }

  private prune(): void {
    for (const [id, entry] of this.entries) if (this.now() - entry.createdAt >= this.ttlMs) this.entries.delete(id);
  }
}

export const analysisSessions = new AnalysisSessionStore();
