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

  return comments.filter((c) => {
    if (!c.body || !c.path || !c.line) return false;
    const lower = c.body.toLowerCase();
    const isFluff = fluffKeywords.some((phrase) => lower.includes(phrase)) && !c.body.includes("```");
    if (isFluff) {
      console.log(`[Sanitizer] Removed sycophantic comment on ${c.path}:${c.line}: "${c.body.slice(0, 50)}..."`);
      return false;
    }
    return true;
  });
}

export async function generatePRReview(pr: PRInfo): Promise<AIReviewResult> {
  const isWeb = isFrontendRepo(pr.repo);
  const isApi = isBackendRepo(pr.repo);

  const diffs = pr.files
    .filter((f) => f.patch)
    .map((f) => `### File: ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n\n");

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
   - If there are no bugs, security flaws, or architectural violations, \`comments\` MUST be an empty array \`[]\`.
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
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "body": "Exact issue description with markdown code replacement snippet..."
    }
  ]
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

    const audit: AuditChecklist = {
      filesInspectedCount: pr.files.length,
      breakingChangesStatus: parsed.audit?.breakingChangesStatus || "NOT_APPLICABLE",
      databaseNPlusOneStatus: parsed.audit?.databaseNPlusOneStatus || "NOT_APPLICABLE",
      tenantIsolationStatus: parsed.audit?.tenantIsolationStatus || "NOT_APPLICABLE",
      uiDesignTokensStatus: parsed.audit?.uiDesignTokensStatus || "NOT_APPLICABLE",
      confidenceScore: typeof parsed.audit?.confidenceScore === "number" ? parsed.audit.confidenceScore : 90,
      auditNotes: parsed.audit?.auditNotes || "Full audit checklist completed.",
    };

    return {
      summary: parsed.summary || "Review completed. No major issues observed.",
      verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.verdict)
        ? parsed.verdict
        : "COMMENT",
      audit,
      comments,
    };
  } catch (error: any) {
    console.error("Gemini API Review Error:", error);
    throw error;
  }
}

/**
 * Generates a unified, cross-repository review for a pair of linked PRs (e.g. Web + API).
 * Rigorously checks for breaking code across Web <-> API, applies repository UI principles and API rules,
 * and formats separate issue comments for each repository.
 */
export async function generatePairedPRReview(prs: PRInfo[]): Promise<AIReviewResult> {
  if (prs.length === 1) {
    return generatePRReview(prs[0]);
  }

  const formattedPRSections = prs
    .map((pr, index) => {
      const diffs = pr.files
        .filter((f) => f.patch)
        .map((f) => `#### File [${pr.repo}]: ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
        .join("\n\n");

      return `
======================================================
Repository #${index + 1}: ${pr.owner}/${pr.repo} (${pr.label || "PR #" + pr.pullNumber})
======================================================
- PR URL: ${pr.url}
- Title: ${pr.title}
- Author: @${pr.author}
- Description: ${pr.description}

Changed Files in ${pr.repo} (${pr.files.length} files):
${diffs || "No patch diff available (e.g. only file creations or binary files)."}
`;
    })
    .join("\n\n");

  const prompt = `
You are a Staff Full-Stack Software Engineer performing a coordinated, adversarial peer code review on a PAIR OF LINKED PULL REQUESTS representing synchronized frontend and backend changes (e.g. Web + API).

${CORE_REVIEW_PRINCIPLES}

${CROSS_REPO_BREAKING_RULES}

${FRONTEND_UI_RULES}

${BACKEND_API_RULES}

${formattedPRSections}

Review Requirements:
1. **CRITICAL BREAKING CODE CHECK (Web <-> API)**:
   - Check if changes in Web will break API, or changes in API will break Web.
   - Check if API introduces new required parameters or validation (e.g. \`required = true\` on a resolver or form submission) that Web does not supply.
   - Check endpoint routes, URL params, request body field names (camelCase vs snake_case), response DTO formats, and enum synchronization.
   - List any breaking change warnings in "breakingChangeWarnings".
2. **DATABASE N+1 QUERY LOOP AUDIT (STRICT CHECK)**:
   - Carefully scan backend changes for any database mutation or select (\`await tx.update\`, \`await tx.select\`, \`await tx.insert\`) inside a loop (\`for\`, \`for...of\`, \`for...in\`, \`.map()\`, \`forEach()\`).
   - If found, you MUST mark \`databaseNPlusOneStatus: "FAILED"\` and create a dedicated comment on the exact line explaining how to batch the operation.
3. **STRICT ZERO-FLUFF MANDATE**:
   - NEVER praise or compliment the code (no "great addition", "looks clean", "well handled").
   - If a PR has no bugs or violations, its \`comments\` array MUST BE EMPTY: \`[]\`.
4. **Frontend STE & Architecture (Web PR in pair)**:
   - Apply PeopleFirst Web rules only to the Web repository diff. Cross-check STE categories from touched files; cite guideline \`id\` on findings.
   - Block \`src/components/ui/\` edits, stack fast-breakers, and common UI regressions (loaders, \`window.confirm\`, wrong tokens).
5. **Dedicated Review per Repository**:
   - Provide a separate review object in "prReviews" for EACH repository.

Respond ONLY with valid JSON strictly adhering to this schema:
{
  "summary": "Unified executive overview of the coordinated full-stack changes...",
  "crossRepoAnalysis": "Detailed analysis of Web <-> API contract compatibility, endpoint matching, type synchronization, and deployment notes...",
  "breakingChangeWarnings": [
    "Warning: API renamed 'company_id' to 'companyId', but Web still accesses 'response.company_id'"
  ],
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "audit": {
    "filesInspectedCount": ${prs.reduce((acc, p) => acc + p.files.length, 0)},
    "breakingChangesStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "databaseNPlusOneStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "tenantIsolationStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "uiDesignTokensStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
    "confidenceScore": 95,
    "auditNotes": "Concise summary of audit findings"
  },
  "prReviews": [
${prs
  .map(
    (p) => `    {
      "repo": "${p.repo}",
      "pullNumber": ${p.pullNumber},
      "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
      "summary": "Specific review summary for ${p.repo}...",
      "audit": {
        "filesInspectedCount": ${p.files.length},
        "breakingChangesStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
        "databaseNPlusOneStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
        "tenantIsolationStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
        "uiDesignTokensStatus": "PASSED" | "FAILED" | "NOT_APPLICABLE",
        "confidenceScore": 95,
        "auditNotes": "Audit notes for ${p.repo}"
      },
      "comments": [
        {
          "repo": "${p.repo}",
          "path": "path/to/file.ts",
          "line": 42,
          "body": "Exact defect with markdown code replacement snippet..."
        }
      ]
    }`
  )
  .join(",\n")}
  ],
  "comments": []
}
`;

  try {
    const responseText = await generateReviewWithFallback(prompt);
    const cleanedText = cleanJsonText(responseText);
    const parsed = JSON.parse(cleanedText);

    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    const prReviews: SinglePRReviewResult[] = [];
    const allComments: ReviewComment[] = [];

    if (Array.isArray(parsed.prReviews)) {
      for (const pr of prs) {
        const found = parsed.prReviews.find(
          (r: any) => String(r.repo).toLowerCase() === pr.repo.toLowerCase()
        );
        const rawRepoComments = Array.isArray(found?.comments)
          ? found.comments.map((c: any) => ({ ...c, repo: pr.repo }))
          : [];
        const sanitizedRepoComments = sanitizeReviewComments(rawRepoComments);

        const prAudit: AuditChecklist = {
          filesInspectedCount: pr.files.length,
          breakingChangesStatus: found?.audit?.breakingChangesStatus || "PASSED",
          databaseNPlusOneStatus: found?.audit?.databaseNPlusOneStatus || "PASSED",
          tenantIsolationStatus: found?.audit?.tenantIsolationStatus || "PASSED",
          uiDesignTokensStatus: found?.audit?.uiDesignTokensStatus || "PASSED",
          confidenceScore: typeof found?.audit?.confidenceScore === "number" ? found.audit.confidenceScore : 92,
          auditNotes: found?.audit?.auditNotes,
        };

        prReviews.push({
          repo: pr.repo,
          pullNumber: pr.pullNumber,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          label: pr.label,
          verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(found?.verdict)
            ? found.verdict
            : "COMMENT",
          summary: found?.summary || `Review for ${pr.repo} completed.`,
          audit: prAudit,
          comments: sanitizedRepoComments,
        });

        allComments.push(...sanitizedRepoComments);
      }
    }

    const overallAudit: AuditChecklist = {
      filesInspectedCount: prs.reduce((acc, p) => acc + p.files.length, 0),
      breakingChangesStatus: parsed.audit?.breakingChangesStatus || "PASSED",
      databaseNPlusOneStatus: parsed.audit?.databaseNPlusOneStatus || "PASSED",
      tenantIsolationStatus: parsed.audit?.tenantIsolationStatus || "PASSED",
      uiDesignTokensStatus: parsed.audit?.uiDesignTokensStatus || "PASSED",
      confidenceScore: typeof parsed.audit?.confidenceScore === "number" ? parsed.audit.confidenceScore : 94,
      auditNotes: parsed.audit?.auditNotes || "Cross-repository audit completed.",
    };

    return {
      summary: parsed.summary || "Coordinated review completed. No major issues observed.",
      crossRepoAnalysis: parsed.crossRepoAnalysis,
      breakingChangeWarnings: Array.isArray(parsed.breakingChangeWarnings) ? parsed.breakingChangeWarnings : [],
      verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.verdict)
        ? parsed.verdict
        : "COMMENT",
      audit: overallAudit,
      prReviews,
      comments: allComments,
    };
  } catch (error: any) {
    console.error("Gemini Paired Review Error:", error);
    throw error;
  }
}
