import { GoogleGenAI } from "@google/genai";
import { PRInfo, AIReviewResult, SinglePRReviewResult, ReviewComment, AuditChecklist } from "./types.js";
import {
  CORE_REVIEW_PRINCIPLES,
  CROSS_REPO_BREAKING_RULES,
  FRONTEND_UI_RULES,
  FRONTEND_MANDATORY_AUDIT,
  BACKEND_API_RULES,
  isFrontendRepo,
  isBackendRepo,
} from "./reviewRules.js";
import {
  normalizeCommentSeverity,
  computeVerdictFromComments,
} from "./reviewCommentUtils.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models to try in order of preference
const CANDIDATE_MODELS = Array.from(
  new Set(
    [
      process.env.GEMINI_MODEL,
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-flash-latest",
    ].filter(Boolean) as string[]
  )
);

export function formatErrorMessage(error: any): string {
  const rawMsg = error?.message || String(error || "Unknown error");
  try {
    const parsed = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;
    if (parsed?.error?.message) {
      const code = parsed.error.code ? `[Error ${parsed.error.code}] ` : "";
      return `${code}${parsed.error.message}`;
    }
  } catch {}
  return rawMsg;
}

function cleanJsonText(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
  }
  return cleaned;
}

function isTransientError(error: any): boolean {
  let code = error?.code || error?.status || error?.error?.code;
  const message = String(error?.message || error || "").toLowerCase();

  try {
    const parsed = typeof error?.message === "string" ? JSON.parse(error.message) : error?.message;
    if (parsed?.error?.code) code = parsed.error.code;
    if (parsed?.error?.status) {
      const s = String(parsed.error.status).toUpperCase();
      if (s === "UNAVAILABLE" || s === "RESOURCE_EXHAUSTED") return true;
    }
  } catch {}

  return (
    code === 503 ||
    code === 429 ||
    code === "UNAVAILABLE" ||
    code === "RESOURCE_EXHAUSTED" ||
    message.includes("high demand") ||
    message.includes("spikes in demand") ||
    message.includes("unavailable") ||
    message.includes("rate limit")
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateReviewWithFallback(prompt: string): Promise<string> {
  let lastError: any = null;

  for (const model of CANDIDATE_MODELS) {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Gemini] Attempting review with model: ${model} (attempt ${attempt}/${maxRetries})...`);
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
          },
        });

        const text = response.text?.trim();
        if (text) {
          console.log(`[Gemini] Successfully generated review with model: ${model}`);
          return text;
        }
      } catch (error: any) {
        lastError = error;
        const transient = isTransientError(error);
        console.warn(
          `[Gemini] Error with model ${model} (attempt ${attempt}/${maxRetries}): ${error.message || error}`
        );

        if (transient && attempt < maxRetries) {
          const delayMs = attempt * 1500;
          console.log(`[Gemini] Transient error encountered. Waiting ${delayMs}ms before retrying ${model}...`);
          await sleep(delayMs);
        } else {
          break;
        }
      }
    }
    console.log(`[Gemini] Switching to fallback model after failures with ${model}...`);
  }

  throw lastError || new Error("All Gemini models failed to generate review.");
}

/**
 * Filter out sycophantic praise or empty fluff from inline comments.
 * Inline comments must only report genuine defects, traps, or questions.
 */
function sanitizeReviewComments(comments: ReviewComment[]): ReviewComment[] {
  const fluffKeywords = [
    "great addition",
    "looks good",
    "looks clean",
    "nicely done",
    "well done",
    "is correctly maintained",
    "looks exceptionally clean",
    "good job",
    "great work",
    "to ensure consistency with other",
  ];

  return comments
    .filter((c) => {
      if (!c.body || !c.path || !c.line) return false;
      const lower = c.body.toLowerCase();
      const isFluff = fluffKeywords.some((phrase) => lower.includes(phrase)) && !c.body.includes("```");
      if (isFluff) {
        console.log(`[Sanitizer] Removed sycophantic comment on ${c.path}:${c.line}: "${c.body.slice(0, 50)}..."`);
        return false;
      }
      return true;
    })
    .map((c) => ({
      ...c,
      severity: normalizeCommentSeverity(c.severity),
    }));
}

function formatDiffsForPrompt(pr: PRInfo): string {
  const diffs = pr.files
    .filter((f) => f.patch)
    .map((f) => `### File: ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n\n");

  let related = "";
  if (pr.relatedContext && pr.relatedContext.length > 0) {
    related =
      "\n\n### Related source context (NOT part of the diff — use for cross-file bugs)\n" +
      pr.relatedContext
        .map(
          (r) =>
            `#### ${r.filename} (${r.reason})\n\`\`\`typescript\n${r.content}\n\`\`\``
        )
        .join("\n\n");
  }

  let ci = "";
  if (pr.ciCheck && pr.ciCheck.status !== "skipped") {
    ci = `\n\n### CI on PR head (${pr.ciCheck.status})\nCommands: ${pr.ciCheck.commandsRun.join(" → ") || "none"}\nIf CI failed, treat build/test failures as **blocking** unless clearly flaky.\n\`\`\`\n${pr.ciCheck.log.slice(-3500)}\n\`\`\``;
  }

  return (diffs || "No patch diff available (e.g. only file creations or binary files).") + related + ci;
}

function toSinglePRReviewResult(pr: PRInfo, parsed: any, comments: ReviewComment[]): SinglePRReviewResult {
  const audit: AuditChecklist = {
    filesInspectedCount: pr.files.length,
    breakingChangesStatus: parsed.audit?.breakingChangesStatus || "NOT_APPLICABLE",
    databaseNPlusOneStatus: parsed.audit?.databaseNPlusOneStatus || "NOT_APPLICABLE",
    tenantIsolationStatus: parsed.audit?.tenantIsolationStatus || "NOT_APPLICABLE",
    uiDesignTokensStatus: parsed.audit?.uiDesignTokensStatus || "NOT_APPLICABLE",
    confidenceScore: typeof parsed.audit?.confidenceScore === "number" ? parsed.audit.confidenceScore : 90,
    auditNotes: parsed.audit?.auditNotes || "Full audit checklist completed.",
  };

  const modelVerdict = ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.verdict)
    ? parsed.verdict
    : "COMMENT";

  return {
    repo: pr.repo,
    pullNumber: pr.pullNumber,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    label: pr.label,
    verdict: computeVerdictFromComments(comments, modelVerdict),
    summary: parsed.summary || "Review completed.",
    audit,
    comments,
  };
}

const COMMENT_JSON_SCHEMA = `
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "severity": "blocking" | "suggestion",
      "body": "Exact issue with markdown code fix. Use blocking for bugs/security/contract/wrong UX data; suggestion for consistency/a11y/architecture."
    }
  ]`;

export async function generatePRReview(pr: PRInfo): Promise<AIReviewResult> {
  const isWeb = isFrontendRepo(pr.repo);
  const isApi = isBackendRepo(pr.repo);

  const diffs = formatDiffsForPrompt(pr);

  const specificRules = isWeb
    ? FRONTEND_UI_RULES
    : isApi
    ? BACKEND_API_RULES
    : `${FRONTEND_UI_RULES}\n${BACKEND_API_RULES}`;

  const prompt = `
You are a Staff Software Engineer performing an adversarial, rigorous, and constructive code review on pull request #${pr.pullNumber} in ${pr.owner}/${pr.repo}.

${CORE_REVIEW_PRINCIPLES}

${specificRules}

Pull Request Details:
- Title: ${pr.title}
- Author: @${pr.author}
- Repository: ${pr.owner}/${pr.repo}
- Description: ${pr.description}

Here is the diff of the changes:
${diffs || "No patch diff available (e.g. only file creations or binary files)."}

Mandatory Audit Steps:
1. **Database N+1 Query Trap Check** (backend / full-stack PRs):
   - Explicitly search for ANY database query (\`await tx.update\`, \`await tx.select\`, \`await tx.insert\`, \`await db...\`) running inside a loop (\`for\`, \`for...of\`, \`for...in\`, \`.map()\`, \`forEach()\`).
   - If found, mark \`databaseNPlusOneStatus: "FAILED"\`, flag the line with an inline comment, and provide the batched query fix.
   - For frontend-only PRs with no DB code, use \`databaseNPlusOneStatus: "NOT_APPLICABLE"\`.
2. **Tenant Isolation Check** (backend):
   - Ensure every database query and mutation has an explicit \`eq(table.tenant, user.tenant)\` filter.
   - For frontend-only PRs, verify TanStack Query keys/params include tenant where applicable; otherwise \`tenantIsolationStatus: "NOT_APPLICABLE"\` if no data layer changes.
3. **Zero-Fluff Mandate**:
   - Do NOT write complimentary comments like "Great addition" or "Looks clean".
   - If there are no blocking bugs and no actionable suggestions, \`comments\` MAY be \`[]\`.
   - Use **Related source context** to find cross-file defects (audit/history/display mismatches).
${isWeb ? FRONTEND_MANDATORY_AUDIT : ""}

Respond ONLY with valid JSON strictly adhering to this schema:
{
  "summary": "Concise, professional summary of changes and review observations...",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "audit": {
    "filesInspectedCount": ${pr.files.length},
    "breakingChangesStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "databaseNPlusOneStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "tenantIsolationStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "uiDesignTokensStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "confidenceScore": 95,
    "auditNotes": "Brief bulleted verification notes on checks executed"
  },
${COMMENT_JSON_SCHEMA}
}
`;

  try {
    const responseText = await generateReviewWithFallback(prompt);
    const cleanedText = cleanJsonText(responseText);
    const parsed = JSON.parse(cleanedText);

    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    const rawComments = Array.isArray(parsed.comments) ? parsed.comments : [];
    const comments = sanitizeReviewComments(rawComments);
    const single = toSinglePRReviewResult(pr, parsed, comments);

    return {
      summary: single.summary,
      verdict: single.verdict,
      audit: single.audit,
      comments,
      prReviews: [single],
    };
  } catch (error: any) {
    console.error("Gemini API Review Error:", error);
    throw error;
  }
}

async function generateCrossRepoCompatibilityReview(
  prs: PRInfo[],
  perRepoReviews: SinglePRReviewResult[]
): Promise<{
  crossRepoAnalysis?: string;
  breakingChangeWarnings: string[];
  crossRepoComments: ReviewComment[];
  breakingChangesStatus: AuditChecklist["breakingChangesStatus"];
}> {
  const contractFilePattern =
    /route|schema|controller|service|api|client|hook|mutation|query|types?\.(ts|tsx)/i;

  const sections = prs
    .map((pr, index) => {
      const repoReview = perRepoReviews.find((r) => r.repo.toLowerCase() === pr.repo.toLowerCase());
      const contractDiffs = pr.files
        .filter((f) => contractFilePattern.test(f.filename) && f.patch)
        .map((f) => `#### [${pr.repo}] ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
        .join("\n\n");

      return `
### Repository ${index + 1}: ${pr.owner}/${pr.repo} (#${pr.pullNumber})
Per-repo summary: ${repoReview?.summary || "N/A"}
Blocking findings so far: ${repoReview?.comments.filter((c) => (c.severity ?? "blocking") === "blocking").length ?? 0}

Contract-relevant diffs:
${contractDiffs || "(none)"}
${pr.relatedContext?.length ? `\nRelated context files: ${pr.relatedContext.map((c) => c.filename).join(", ")}` : ""}
`;
    })
    .join("\n");

  const prompt = `
You are verifying Web ⟷ API compatibility for a PAIR of linked pull requests (full-stack feature).

${CROSS_REPO_BREAKING_RULES}

${CORE_REVIEW_PRINCIPLES}

Focus ONLY on cross-repository contract, shared field semantics (IDs vs display names in audit/history UI), deployment order, and bugs that require BOTH repos to reason about.

Per-repo deep reviews are ALREADY DONE. Do NOT repeat their findings unless you found a NEW cross-repo defect.

${sections}

Respond ONLY with JSON:
{
  "crossRepoAnalysis": "Detailed Web ⟷ API compatibility narrative...",
  "breakingChangeWarnings": ["..."],
  "breakingChangesStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
  "comments": [
    {
      "repo": "exact repo name from input",
      "path": "file in that repo",
      "line": 42,
      "severity": "blocking" | "suggestion",
      "body": "Cross-repo issue with fix"
    }
  ]
}
`;

  try {
    const responseText = await generateReviewWithFallback(prompt);
    const parsed = JSON.parse(cleanJsonText(responseText));
    const crossRepoComments = sanitizeReviewComments(
      Array.isArray(parsed.comments)
        ? parsed.comments.map((c: any) => ({
            ...c,
            repo: prs.find((p) => p.repo.toLowerCase() === String(c.repo || "").toLowerCase())?.repo ?? c.repo,
          }))
        : []
    );

    return {
      crossRepoAnalysis: parsed.crossRepoAnalysis,
      breakingChangeWarnings: Array.isArray(parsed.breakingChangeWarnings) ? parsed.breakingChangeWarnings : [],
      crossRepoComments,
      breakingChangesStatus: parsed.breakingChangesStatus || (crossRepoComments.length ? "FAILED" : "PASSED"),
    };
  } catch (error) {
    console.warn("[Gemini] Cross-repo pass failed, continuing with per-repo reviews only:", error);
    return {
      breakingChangeWarnings: [],
      crossRepoComments: [],
      breakingChangesStatus: "NOT_APPLICABLE",
    };
  }
}

function mergeCrossRepoComments(
  perRepoReviews: SinglePRReviewResult[],
  crossRepoComments: ReviewComment[]
): SinglePRReviewResult[] {
  return perRepoReviews.map((review) => {
    const extras = crossRepoComments.filter(
      (c) => c.repo && c.repo.toLowerCase() === review.repo.toLowerCase()
    );
    if (extras.length === 0) return review;
    const merged = sanitizeReviewComments([...review.comments, ...extras]);
    return {
      ...review,
      comments: merged,
      verdict: computeVerdictFromComments(merged, review.verdict),
    };
  });
}

function mergeOverallAudit(prReviews: SinglePRReviewResult[]): AuditChecklist {
  const pickWorst = (key: keyof AuditChecklist): "PASSED" | "FAILED" | "NOT_APPLICABLE" => {
    const statuses = prReviews.map((r) => r.audit?.[key]).filter(Boolean) as string[];
    if (statuses.includes("FAILED")) return "FAILED";
    if (statuses.every((s) => s === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
    return "PASSED";
  };

  const scores = prReviews.map((r) => r.audit?.confidenceScore ?? 90);
  const minScore = scores.length ? Math.min(...scores) : 90;

  return {
    filesInspectedCount: prReviews.reduce((acc, r) => acc + (r.audit?.filesInspectedCount ?? 0), 0),
    breakingChangesStatus: pickWorst("breakingChangesStatus"),
    databaseNPlusOneStatus: pickWorst("databaseNPlusOneStatus"),
    tenantIsolationStatus: pickWorst("tenantIsolationStatus"),
    uiDesignTokensStatus: pickWorst("uiDesignTokensStatus"),
    confidenceScore: minScore,
    auditNotes: "Split per-repo review + dedicated cross-repo compatibility pass.",
  };
}

/**
 * Paired PR review: one Gemini pass per repository, then a focused Web ⟷ API pass.
 */
export async function generatePairedPRReview(prs: PRInfo[]): Promise<AIReviewResult> {
  if (prs.length === 1) {
    return generatePRReview(prs[0]);
  }

  console.log(`[Review] Split paired review: ${prs.length} parallel per-repo passes...`);
  const perRepoResults = await Promise.all(prs.map((pr) => generatePRReview(pr)));

  let prReviews: SinglePRReviewResult[] = perRepoResults.map((result, i) => {
    const fromNested = result.prReviews?.[0];
    if (fromNested) return fromNested;
    return {
      repo: prs[i].repo,
      pullNumber: prs[i].pullNumber,
      title: prs[i].title,
      url: prs[i].url,
      author: prs[i].author,
      label: prs[i].label,
      verdict: result.verdict,
      summary: result.summary,
      audit: result.audit,
      comments: result.comments,
    };
  });

  console.log("[Review] Cross-repo compatibility pass...");
  const cross = await generateCrossRepoCompatibilityReview(prs, prReviews);
  prReviews = mergeCrossRepoComments(prReviews, cross.crossRepoComments);

  if (cross.breakingChangesStatus === "FAILED") {
    prReviews = prReviews.map((r) => ({
      ...r,
      audit: r.audit
        ? { ...r.audit, breakingChangesStatus: "FAILED" as const }
        : r.audit,
    }));
  }

  const allComments = prReviews.flatMap((r) => r.comments.map((c) => ({ ...c, repo: r.repo })));
  const overallVerdict = prReviews.some((r) => r.verdict === "REQUEST_CHANGES")
    ? "REQUEST_CHANGES"
    : prReviews.some((r) => r.verdict === "COMMENT")
    ? "COMMENT"
    : "APPROVE";

  const summary =
    prReviews.map((r) => `**${r.label || r.repo}**: ${r.summary}`).join("\n\n") ||
    "Coordinated review completed.";

  const overallAudit = mergeOverallAudit(prReviews);
  if (cross.breakingChangesStatus === "FAILED") {
    overallAudit.breakingChangesStatus = "FAILED";
  }

  return {
    summary,
    crossRepoAnalysis: cross.crossRepoAnalysis,
    breakingChangeWarnings: cross.breakingChangeWarnings,
    verdict: overallVerdict,
    audit: overallAudit,
    prReviews,
    comments: allComments,
  };
}
