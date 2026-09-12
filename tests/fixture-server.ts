// Test-only AG-UI fixture: exercises the real CopilotKit runtime and browser transport.
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { createApp } from "../server/index.js";
import { parseIssueUrl, parseRepositoryUrl } from "../shared/contracts.js";
import { fixtureRepositoryState, fixtureState } from "./fixture-data.js";

class FixtureAgent extends AbstractAgent {
  constructor() { super({ agentId: "repolens", description: "Automated test fixture" }); }
  override clone(): FixtureAgent { return new FixtureAgent(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const props = input.forwardedProps as { issue?: { url?: string }; repository?: { url?: string }; intent?: string };
      const repository = parseRepositoryUrl(props?.repository?.url || "");
      if (props.intent === "understand_repository" && repository) {
        observer.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        const state = fixtureRepositoryState(repository, input.runId);
        observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { ...state, repositoryAnalysis: null, repositoryAnalysisId: null, status: "loading", phase: "Reading the README and project manifest" } });
        const repositoryTimer = setTimeout(() => {
          observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: state });
          observer.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
          observer.complete();
        }, 200);
        return () => clearTimeout(repositoryTimer);
      }
      const issue = parseIssueUrl(props?.issue?.url || "");
      if (!issue) { observer.error(new Error("Missing test issue")); return; }
      observer.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      const state = fixtureState(issue, input.runId);
      if (props.intent === "understand") {
        observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { ...state, analysis: null, analysisId: null, status: "loading", phase: "Reading GitHub comments" } });
      }
      const timer = setTimeout(() => {
        if (issue.number === 403) {
          state.status = "permission_denied";
          state.analysis = null;
          state.analysisId = null;
          state.error = { code: "PERMISSION_DENIED", message: "This repository is private or unavailable.", retryable: false };
        } else if (props.intent === "propose_solution" || props.intent === "implement_solution") {
          state.solution = {
            status: "proposed", approach: { text: "Normalize the OAuth identity before session validation.", sourceIds: ["file-1", "file-2"] }, assumptions: ["Both readers must share the same identity field."],
            steps: [{ title: "Align the session identity", detail: "Use a consistent field between the callback and middleware.", files: ["src/auth/callback.ts", "src/auth/middleware.ts"], validation: "Add a sign-in regression test.", sourceIds: ["file-1", "file-2"] }], risks: [], openQuestions: [],
          };
          if (props.intent === "implement_solution") {
            state.implementation = {
              status: "drafted",
              summary: { text: "Use the identity field already consumed by the session middleware.", sourceIds: ["file-1", "file-2"] },
              files: [{ path: "src/auth/callback.ts", explanation: "Store the OAuth identity under userId.", sourceIds: ["file-2"] }],
              patch: "diff --git a/src/auth/callback.ts b/src/auth/callback.ts\n--- a/src/auth/callback.ts\n+++ b/src/auth/callback.ts\n@@ -8,2 +8,2 @@\n- session.sub = identity.id;\n+ session.userId = identity.id;",
              validationCommands: [],
              notes: ["Review and test this draft before applying it."],
            };
          }
        }
        observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: state });
        observer.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
        observer.complete();
      }, issue.number === 999 ? 4000 : 200);
      return () => clearTimeout(timer);
    });
  }
}

createApp({ port: 3001, host: "127.0.0.1", model: "test-fixture", openaiApiKey: "test-only", githubToken: "test-only", runLimitPerMinute: 100 }, new FixtureAgent()).listen(3001, "127.0.0.1", () => console.log("Test fixture server ready (no external calls)"));
