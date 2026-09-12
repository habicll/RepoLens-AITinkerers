// Test-only AG-UI fixture: exercises the real CopilotKit runtime and browser transport.
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { createApp } from "../server/index.js";
import { parseIssueUrl } from "../shared/contracts.js";
import { fixtureState } from "./fixture-data.js";

class FixtureAgent extends AbstractAgent {
  constructor() { super({ agentId: "repolens", description: "Automated test fixture" }); }
  override clone(): FixtureAgent { return new FixtureAgent(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const props = input.forwardedProps as { issue?: { url?: string }; intent?: string };
      const issue = parseIssueUrl(props?.issue?.url || "");
      if (!issue) { observer.error(new Error("Missing test issue")); return; }
      observer.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      const state = fixtureState(issue, input.runId);
      if (props.intent !== "propose_solution") {
        observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { ...state, analysis: null, analysisId: null, status: "loading", phase: "Reading GitHub comments" } });
      }
      const timer = setTimeout(() => {
        if (issue.number === 403) {
          state.status = "permission_denied";
          state.analysis = null;
          state.analysisId = null;
          state.error = { code: "PERMISSION_DENIED", message: "This repository is private or unavailable.", retryable: false };
        } else if (props.intent === "propose_solution") {
          state.solution = {
            status: "proposed", approach: { text: "Normalize the OAuth identity before session validation.", sourceIds: ["file-1", "file-2"] }, assumptions: ["Both readers must share the same identity field."],
            steps: [{ title: "Align the session identity", detail: "Use a consistent field between the callback and middleware.", files: ["src/auth/callback.ts", "src/auth/middleware.ts"], validation: "Add a sign-in regression test.", sourceIds: ["file-1", "file-2"] }], risks: [], openQuestions: [],
          };
        }
        observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: state });
        observer.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
        observer.complete();
      }, issue.number === 999 ? 4000 : 200);
      return () => clearTimeout(timer);
    });
  }
}

createApp({ port: 3001, host: "127.0.0.1", model: "test-fixture", openaiApiKey: "test-only", githubToken: "test-only" }, new FixtureAgent()).listen(3001, "127.0.0.1", () => console.log("Test fixture server ready (no external calls)"));
