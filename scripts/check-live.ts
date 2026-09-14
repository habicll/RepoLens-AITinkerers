import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/core";
import { RepoLensAgent } from "../server/agent.js";
import { parseIssueUrl, parseRepositoryUrl, type RepoLensState } from "../shared/contracts.js";

const issue = parseIssueUrl(process.argv[2] || "https://github.com/expressjs/express/issues/7350");
const repository = issue ? null : parseRepositoryUrl(process.argv[2] || "");
if (!issue && !repository) throw new Error("Pass a valid public GitHub repository or issue URL.");
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("Configure OPENAI_API_KEY in .env first.");
const windowDays = Number(process.env.FORENSICS_WINDOW_DAYS || 7);
const agent = new RepoLensAgent({ openaiApiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-5.4", githubToken: process.env.GITHUB_TOKEN,
  forensicsWindowDays: Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 30 ? windowDays : 7 });
const threadId = randomUUID();

async function run(intent: "understand" | "propose_solution" | "investigate_issue" | "understand_repository", analysisId?: string): Promise<RepoLensState> {
  const target = issue
    ? { context: [{ description: "Current GitHub issue", value: JSON.stringify(issue) }], forwardedProps: { intent, issue, ...(analysisId ? { analysisId } : {}) } }
    : { context: [{ description: "Current GitHub repository", value: JSON.stringify(repository) }], forwardedProps: { intent: "understand_repository", repository } };
  const input: RunAgentInput = { threadId, runId: randomUUID(), state: {}, messages: [], tools: [],
    ...target,
  };
  return new Promise((resolve, reject) => {
    let result: RepoLensState | undefined;
    let phase = "";
    agent.run(input).subscribe({
      next(event) {
        if (event.type === "STATE_SNAPSHOT") {
          result = (event as unknown as { snapshot: RepoLensState }).snapshot;
          const nextPhase = intent === "investigate_issue" ? result.forensicsPhase : result.phase;
          if (nextPhase !== phase) { phase = nextPhase; console.log(phase); }
        }
      },
      error: reject,
      complete() {
        if (!result || result.status !== "complete") reject(new Error(result?.error?.message || "No completed analysis."));
        else if (intent === "investigate_issue" && !result.forensics) reject(new Error(result.forensicsError?.message || "No completed Forensics result."));
        else resolve(result);
      },
    });
  });
}

const analysis = await run(issue ? "understand" : "understand_repository");
await mkdir("local-results", { recursive: true });
await writeFile(issue ? "local-results/live-analysis.json" : "local-results/live-repository.json", JSON.stringify(analysis, null, 2));
console.log(JSON.stringify(issue
  ? { issue: issue.url, summary: analysis.analysis?.summary, facts: analysis.analysis?.facts, files: analysis.analysis?.relevantFiles, coverage: analysis.coverage }
  : { repository: repository!.url, summary: analysis.repositoryAnalysis?.summary, concepts: analysis.repositoryAnalysis?.keyConcepts, quickStart: analysis.repositoryAnalysis?.quickStart, launch: analysis.launchProposal, coverage: analysis.coverage }, null, 2));
if (issue && process.argv.includes("--solution")) {
  const solution = await run("propose_solution", analysis.analysisId!);
  await writeFile("local-results/live-solution.json", JSON.stringify(solution, null, 2));
  console.log(JSON.stringify({ approach: solution.solution?.approach, steps: solution.solution?.steps.length }, null, 2));
}
if (issue && process.argv.includes("--forensics")) {
  const forensics = await run("investigate_issue", analysis.analysisId!);
  await writeFile("local-results/live-forensics.json", JSON.stringify(forensics, null, 2));
  console.log(JSON.stringify({ status: forensics.forensics?.status, summary: forensics.forensics?.summary,
    candidate: forensics.forensics?.candidates[0], timelineEvents: forensics.forensics?.timeline.length, coverage: forensics.forensics?.coverage }, null, 2));
}
