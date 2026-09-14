import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { FunctionTool, Response, ResponseCreateParamsNonStreaming, ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";
import { AnalysisSchema, ClaimSchema, ImplementationDraftSchema, RepositoryAnalysisSchema, SolutionSchema, type Analysis, type ImplementationDraft, type RepositoryAnalysis, type Solution, type Source, type IssueRef, type IssueMetadata, type Snapshot, type Coverage } from "../shared/contracts.js";
import { AppError } from "./errors.js";
import { ANALYSIS_PROMPT, FORENSICS_PROMPT, IMPLEMENTATION_PROMPT, INVESTIGATION_PROMPT, REPOSITORY_PROMPT, SOLUTION_PROMPT } from "./prompts.js";

export interface RepositoryReader {
  metadata: IssueMetadata | null;
  snapshot: Snapshot | null;
  sources: Source[];
  coverage: Coverage;
  bootstrap(): Promise<unknown>;
  getSeed(): unknown;
  overview(directory?: string): Promise<unknown>;
  search(terms: string, pathPrefix?: string): Promise<unknown>;
  readFile(path: string, startLine?: number, endLine?: number): Promise<unknown>;
}
export type ModelResponse = Pick<Response, "output" | "usage" | "status">;
export type Complete = (parameters: ResponseCreateParamsNonStreaming, signal: AbortSignal) => Promise<ModelResponse>;
export interface UsageCounts { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number }
export const MAX_MODEL_CALLS = 6;
export const MAX_TOOL_CALLS = 10;
const MAX_EVIDENCE_CHARS = 80_000;

export const ForensicsReasoningSchema = z.object({
  summary: ClaimSchema,
  assessments: z.array(z.object({
    candidateId: z.string().min(1).max(160),
    semanticRelevance: z.enum(["high", "medium", "low"]),
    inference: z.string().min(1).max(600),
    sourceIds: z.array(z.string()).min(1).max(6),
  })).max(6),
  inferences: z.array(ClaimSchema).max(4),
});
export type ForensicsReasoning = z.infer<typeof ForensicsReasoningSchema>;
const reasoningForModel = (model: string): ResponseCreateParamsNonStreaming["reasoning"] =>
  /^gpt-5(?:[.-]|$)/.test(model) && !/(?:pro|chat|codex)/.test(model) ? { effort: "low" } : undefined;

/** When a discussion exists, its highlights cannot be replaced by issue/code restatements. */
export function analysisOutputSchema(sources: Source[]): z.ZodType<Analysis> {
  const commentIds = [...new Set(sources.filter(source => source.kind === "comment").map(source => source.id))];
  if (!commentIds.length) return AnalysisSchema;
  const discussionClaim = ClaimSchema.extend({
    sourceIds: z.array(z.enum(commentIds as [string, ...string[]])).min(1).max(6),
  });
  return AnalysisSchema.extend({
    facts: z.array(discussionClaim).min(1).max(3).describe("One to three short discussion highlights, each citing only supplied comment IDs. Prioritize disagreements, counterexamples, and reported outcomes."),
  });
}

export function openAICompletion(apiKey: string): Complete {
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 85_000 });
  return (parameters, signal) => client.responses.create(parameters, { signal });
}

const ToolArgs = {
  repo_overview: z.object({ directory: z.string().max(250).nullable() }).strict(),
  search_repository: z.object({ terms: z.string().min(1).max(180), pathPrefix: z.string().max(250).nullable() }).strict(),
  read_file: z.object({ path: z.string().min(1).max(500), startLine: z.number().int().positive().nullable(), endLine: z.number().int().positive().nullable() }).strict(),
};
export const REPOSITORY_TOOLS: FunctionTool[] = [
  { type: "function", name: "repo_overview", description: "List a bounded directory of the current repository at the pinned commit. Paths are candidates, not read evidence.", strict: true,
    parameters: { type: "object", properties: { directory: { type: ["string", "null"] } }, required: ["directory"], additionalProperties: false } },
  { type: "function", name: "search_repository", description: "Find candidate file paths from short distinctive terms. Results are not evidence until read_file inspects them.", strict: true,
    parameters: { type: "object", properties: { terms: { type: "string" }, pathPrefix: { type: ["string", "null"] } }, required: ["terms", "pathPrefix"], additionalProperties: false } },
  { type: "function", name: "read_file", description: "Read a bounded line range in a relevant text file at the pinned commit; returns source IDs for citation. At most six unique files total.", strict: true,
    parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: ["integer", "null"] }, endLine: { type: ["integer", "null"] } }, required: ["path", "startLine", "endLine"], additionalProperties: false } },
];

export function validateEvidence(result: Analysis | Solution | ImplementationDraft | RepositoryAnalysis | ForensicsReasoning, sources: Source[]): void {
  const byId = new Map(sources.map(source => [source.id, source]));
  const visit = (value: unknown): void => {
    if (typeof value === "string" && sources.some(source => value.includes(source.id))) {
      throw new AppError("INVALID_OUTPUT", "The generated text included internal citation identifiers. Please retry.", 502, true);
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.sourceIds) && record.sourceIds.some(id => typeof id !== "string" || !byId.has(id))) {
      throw new AppError("INVALID_EVIDENCE", "The generated result contained a citation that was not retrieved. Please retry.", 502, true);
    }
    for (const [key, child] of Object.entries(record)) if (key !== "sourceIds") visit(child);
  };
  visit(result);
  const checkPath = (path: string, sourceIds: string[]): void => {
    if (!sourceIds.some(id => { const source = byId.get(id); return source?.path === path && (source.kind === "file" || source.kind === "readme"); })) {
      throw new AppError("INVALID_EVIDENCE", "The generated result referred to a file without inspected evidence. Please retry.", 502, true);
    }
  };
  if ("relevantFiles" in result) {
    for (const file of result.relevantFiles) checkPath(file.path, file.sourceIds);
    if (result.reproduction.status === "missing" && result.reproduction.steps.length) {
      throw new AppError("INVALID_EVIDENCE", "The generated result included unsupported reproduction steps. Please retry.", 502, true);
    }
  } else if ("steps" in result) {
    for (const step of result.steps) for (const path of step.files) checkPath(path, step.sourceIds);
    if (result.status === "needs_more_information" && result.steps.length) {
      throw new AppError("INVALID_EVIDENCE", "The proposed plan conflicts with its missing-information status. Please retry.", 502, true);
    }
  } else if ("files" in result) {
    for (const file of result.files) checkPath(file.path, file.sourceIds);
    validateImplementationPatch(result);
  }
}

export function validateImplementationPatch(draft: ImplementationDraft): void {
  if (draft.status === "needs_more_information") {
    if (draft.patch.trim() || draft.files.length) throw new AppError("INVALID_PATCH", "A blocked implementation cannot contain a speculative patch.", 502, true);
    return;
  }
  if (!draft.patch.trim() || !draft.files.length) throw new AppError("INVALID_PATCH", "The implementation draft did not contain a patch and inspected files.", 502, true);
  if (/\/dev\/null|GIT binary patch|Binary files /i.test(draft.patch)) {
    throw new AppError("INVALID_PATCH", "The generated patch attempted an unsupported file operation. Please retry.", 502, true);
  }
  const headers = [...draft.patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  const paths = new Set<string>();
  for (const header of headers) {
    if (header[1] !== header[2] || /(^|\/)\.\.(\/|$)/.test(header[1]) || header[1].startsWith("/")) {
      throw new AppError("INVALID_PATCH", "The generated patch changed an unexpected path. Please retry.", 502, true);
    }
    paths.add(header[1]);
  }
  const declared = new Set(draft.files.map(file => file.path));
  if (!headers.length || !/^diff --git /m.test(draft.patch) || !/^--- a\//m.test(draft.patch) || !/^\+\+\+ b\//m.test(draft.patch) || !/^@@ /m.test(draft.patch)
    || paths.size !== declared.size || [...paths].some(path => !declared.has(path)) || [...declared].some(path => !paths.has(path))) {
    throw new AppError("INVALID_PATCH", "The generated patch was incomplete or did not match its inspected files. Please retry.", 502, true);
  }
}

function textOf(response: ModelResponse): string {
  if (response.status === "incomplete" || response.status === "failed") throw new AppError("MODEL_INCOMPLETE", "The model could not finish this result. Please retry.", 502, true);
  if (response.output.some(item => item.type === "message" && item.content.some(content => content.type === "refusal"))) {
    throw new AppError("MODEL_REFUSAL", "The model declined to analyze the supplied content. No result was generated.", 422);
  }
  return response.output.flatMap(item => item.type === "message" ? item.content.flatMap(content => content.type === "output_text" ? [content.text] : []) : []).join("");
}

function account(response: ModelResponse, counts: UsageCounts): void {
  counts.inputTokens += response.usage?.input_tokens ?? 0;
  counts.outputTokens += response.usage?.output_tokens ?? 0;
}

async function finalResult<T extends Analysis | Solution | ImplementationDraft | RepositoryAnalysis | ForensicsReasoning>(options: {
  schema: z.ZodType<T>; name: string; instructions: string; evidence: string;
  model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts; sources: Source[]; maxOutputTokens?: number;
}): Promise<T> {
  options.signal.throwIfAborted();
  if (options.evidence.length > MAX_EVIDENCE_CHARS) throw new AppError("CONTEXT_BUDGET", "The saved evidence and analysis exceed the safe context budget. Run Understand again with a smaller issue.", 413);
  if (options.counts.modelCalls >= MAX_MODEL_CALLS) throw new AppError("MODEL_BUDGET", "The analysis reached its model-call limit. Please retry.", 429, true);
  options.counts.modelCalls += 1;
  const response = await options.complete({ model: options.model, store: false, stream: false,
    reasoning: reasoningForModel(options.model),
    instructions: options.instructions, input: [{ role: "user", content: options.evidence }],
    max_output_tokens: options.maxOutputTokens ?? 6_000, text: { format: zodTextFormat(options.schema, options.name) },
  }, options.signal);
  options.signal.throwIfAborted();
  account(response, options.counts);
  let parsed: unknown;
  try { parsed = JSON.parse(textOf(response)); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("INVALID_OUTPUT", "The model did not return a complete structured result. Please retry.", 502, true); }
  const result = options.schema.safeParse(parsed);
  if (!result.success) throw new AppError("INVALID_OUTPUT", "The model returned an invalid structured result. Please retry.", 502, true);
  validateEvidence(result.data, options.sources);
  return result.data;
}

export async function understandRepository(options: {
  evidence: string; sources: Source[]; model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts;
}): Promise<RepositoryAnalysis> {
  return finalResult({ ...options, schema: RepositoryAnalysisSchema, name: "repository_briefing", instructions: REPOSITORY_PROMPT, evidence: options.evidence, maxOutputTokens: 4_500 });
}

export async function reasonForensics(options: {
  evidence: string; sources: Source[]; model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts;
}): Promise<ForensicsReasoning> {
  return finalResult({ ...options, schema: ForensicsReasoningSchema, name: "issue_forensics_reasoning", instructions: FORENSICS_PROMPT,
    evidence: options.evidence, maxOutputTokens: 3_000 });
}

export async function understand(options: {
  issue: IssueRef; repository: RepositoryReader; model: string; complete: Complete; signal: AbortSignal;
  counts: UsageCounts; report: (label: string) => void; deadline: number;
}): Promise<{ analysis: Analysis; evidence: string }> {
  const { repository, counts, signal } = options;
  const seed = repository.getSeed();
  const evidence = () => JSON.stringify({ issue: options.issue, snapshot: repository.snapshot,
    metadata: repository.metadata, sources: repository.sources, coverage: repository.coverage });
  const registry = repository.sources.map(({ excerpt: _excerpt, ...source }) => source);
  const input: ResponseInput = [{ role: "user", content: JSON.stringify({ issue: options.issue, seed, sourceRegistry: registry }) }];
  let explorationLimited = false;

  // Leave one model call and a time reserve for the validated final result.
  while (!explorationLimited && counts.modelCalls < MAX_MODEL_CALLS - 1 && counts.toolCalls < MAX_TOOL_CALLS && Date.now() < options.deadline - 30_000) {
    signal.throwIfAborted();
    if (JSON.stringify(input).length > MAX_EVIDENCE_CHARS || evidence().length > MAX_EVIDENCE_CHARS - 14_000) {
      repository.coverage.limits.push("The context budget was reached; investigation stopped before reading more files.");
      break;
    }
    options.report("Choosing relevant repository evidence");
    counts.modelCalls += 1;
    const response = await options.complete({ model: options.model, store: false, stream: false,
      reasoning: reasoningForModel(options.model),
      instructions: INVESTIGATION_PROMPT, input, tools: REPOSITORY_TOOLS, parallel_tool_calls: false,
      max_output_tokens: 2_500, include: ["reasoning.encrypted_content"],
    }, signal);
    signal.throwIfAborted();
    account(response, counts);
    const calls = response.output.filter(item => item.type === "function_call");
    if (!calls.length) break;
    input.push(...response.output.filter(item => item.type === "function_call" || item.type === "reasoning" || item.type === "message"));
    for (const call of calls) {
      signal.throwIfAborted();
      let result: unknown;
      let args: unknown = {};
      try {
        if (counts.toolCalls >= MAX_TOOL_CALLS || explorationLimited) throw new AppError("TOOL_BUDGET", "Repository tool limit reached.", 429);
        counts.toolCalls += 1;
        args = JSON.parse(call.arguments);
        if (call.name === "repo_overview") { const parsed = ToolArgs.repo_overview.parse(args); result = await repository.overview(parsed.directory ?? undefined); }
        else if (call.name === "search_repository") { const parsed = ToolArgs.search_repository.parse(args); result = await repository.search(parsed.terms, parsed.pathPrefix ?? undefined); }
        else if (call.name === "read_file") { const parsed = ToolArgs.read_file.parse(args); result = await repository.readFile(parsed.path, parsed.startLine ?? undefined, parsed.endLine ?? undefined); }
        else throw new AppError("UNKNOWN_TOOL", "This tool is not available.");
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError && ([401, 403].includes(error.status) || error.code === "GITHUB_RATE_LIMIT")) throw error;
        if (error instanceof AppError && error.code === "CONTEXT_BUDGET") explorationLimited = true;
        result = { error: error instanceof AppError ? error.message : "Invalid tool arguments or unavailable evidence." };
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      options.report("Repository evidence updated");
    }
  }
  if (counts.toolCalls >= MAX_TOOL_CALLS) repository.coverage.limits.push("Maximum repository tool calls reached.");
  if (counts.modelCalls >= MAX_MODEL_CALLS - 1) repository.coverage.limits.push("Investigation call budget reached; remaining capacity reserved for the summary.");
  options.report("Writing the evidence-backed summary");
  // Store inspected excerpts once; search traces and model reasoning are not evidence.
  const finalEvidence = evidence();
  if (finalEvidence.length > MAX_EVIDENCE_CHARS) throw new AppError("CONTEXT_BUDGET", "The retrieved evidence exceeded the safe context budget.", 413);
  const analysis = await finalResult({ ...options, schema: analysisOutputSchema(repository.sources), name: "issue_analysis", instructions: ANALYSIS_PROMPT, evidence: finalEvidence, sources: repository.sources });
  return { analysis, evidence: finalEvidence };
}

export async function proposeSolution(options: {
  analysis: Analysis; evidence: string; sources: Source[]; model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts;
}): Promise<Solution> {
  return finalResult({ ...options, schema: SolutionSchema, name: "proposed_solution", instructions: SOLUTION_PROMPT,
    evidence: JSON.stringify({ savedAnalysis: options.analysis, savedEvidence: JSON.parse(options.evidence) }),
  });
}

export async function implementSolution(options: {
  analysis: Analysis; solution: Solution; evidence: string; sources: Source[]; model: string; complete: Complete; signal: AbortSignal; counts: UsageCounts;
}): Promise<ImplementationDraft> {
  if (options.solution.status !== "proposed" || !options.solution.steps.length) {
    throw new AppError("SOLUTION_REQUIRED", "Resolve the open questions and generate a concrete solution before requesting an implementation.", 409);
  }
  return finalResult({ ...options, schema: ImplementationDraftSchema, name: "implementation_draft", instructions: IMPLEMENTATION_PROMPT,
    evidence: JSON.stringify({ savedAnalysis: options.analysis, savedSolution: options.solution, savedEvidence: JSON.parse(options.evidence) }),
    maxOutputTokens: 8_000,
  });
}
