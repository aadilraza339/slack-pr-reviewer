import { GoogleGenAI } from "@google/genai";
import { PRInfo, AIReviewResult, SinglePRReviewResult } from "./types.js";
import {
  CORE_REVIEW_PRINCIPLES,
  CROSS_REPO_BREAKING_RULES,
  FRONTEND_UI_RULES,
  BACKEND_API_RULES,
} from "./reviewRules.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models to try in order of preference.
// gemini-3.5-flash is fast, reliable, and has consistent capacity.
const CANDIDATE_MODELS = Array.from(
  new Set(
    [
      process.env.GEMINI_MODEL,
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
    ].filter(Boolean) as string[]
  )
);

function isTransientError(error: any): boolean {
  const code = error?.code || error?.status || error?.error?.code;
  const message = String(error?.message || error || "").toLowerCase();
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

export async function generatePRReview(pr: PRInfo): Promise<AIReviewResult> {
  const isWeb = /web|front/i.test(pr.repo);
  const isApi = /api|back|srv/i.test(pr.repo);

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
You are a Staff Software Engineer performing a peer code review on pull request #${pr.pullNumber} in ${pr.owner}/${pr.repo}.

${CORE_REVIEW_PRINCIPLES}

${specificRules}

Pull Request Details:
- Title: ${pr.title}
- Author: @${pr.author}
- Repository: ${pr.owner}/${pr.repo}
- Description: ${pr.description}

Here is the diff of the changes:
${diffs || "No patch diff available (e.g. only file creations or binary files)."}

Review Requirements:
1. Examine the code for potential bugs, logic flaws, security vulnerabilities, unhandled edge cases, and missing tests.
2. Adhere strictly to the repository rules above (e.g. One Surface rule, token colors, TanStack Query, tenant scoping, no N+1 query loops).
3. Write comments in a natural, polite, and human teammate voice with proper English grammar. Provide concrete markdown code fixes wherever applicable.
4. For each inline comment:
   - "path": Must match the exact filename from the diff.
   - "line": Valid integer line number in the modified file.
   - "body": Clear description of the issue with a suggested fix in fenced code blocks.
5. Overall verdict:
   - "APPROVE": Solid with no blocking defects.
   - "REQUEST_CHANGES": Critical defect, security flaw, or violation of repository hard rules found.
   - "COMMENT": Informational suggestions without blocking merge.

Respond ONLY with valid JSON strictly adhering to this schema:
{
  "summary": "Clear, friendly, human summary of changes and review observations...",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "body": "Comment with suggestion..."
    }
  ]
}
`;

  try {
    const responseText = await generateReviewWithFallback(prompt);
    const parsed = JSON.parse(responseText);

    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    return {
      summary: parsed.summary || "Review completed. No major issues observed.",
      verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.verdict)
        ? parsed.verdict
        : "COMMENT",
      comments,
    };
  } catch (error: any) {
    console.error("Gemini API Review Error:", error);
    return {
      summary: `Automated review failed to parse: ${error.message || "Unknown error"}`,
      verdict: "COMMENT",
      comments: [],
    };
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

Changed Files in ${pr.repo}:
${diffs || "No patch diff available (e.g. only file creations or binary files)."}
`;
    })
    .join("\n\n");

  const prompt = `
You are a Staff Full-Stack Software Engineer performing a coordinated peer code review on a PAIR OF LINKED PULL REQUESTS representing synchronized frontend and backend changes (e.g. Web + API).

${CORE_REVIEW_PRINCIPLES}

${CROSS_REPO_BREAKING_RULES}

${FRONTEND_UI_RULES}

${BACKEND_API_RULES}

${formattedPRSections}

Review Requirements:
1. **CRITICAL BREAKING CODE CHECK (Web <-> API)**:
   - Check if changes in Web will break API, or changes in API will break Web.
   - Specifically check endpoint routes, URL params, request body fields (required vs optional), response DTO formats, enum synchronization, and migration deployment order.
   - List any breaking change warnings explicitly in the "breakingChangeWarnings" array.
2. **Repository Specific Rules**:
   - For Web (${prs.find((p) => /web|front/i.test(p.repo))?.repo || "Frontend"}): Enforce the One Surface rule (never nest a Card in a Card, forms flat, no Card around tables), slot order, action button placement in Page Bar, design tokens only (no text-gray-*), TanStack Query, and no modified ShadCN primitives.
   - For API (${prs.find((p) => /api|back|srv/i.test(p.repo))?.repo || "Backend"}): Enforce tenant isolation scoping on every query, no IDOR, no N+1 query loops, push filtering to database, and guard clauses.
3. **Tone and Style**:
   - Write as a human engineering teammate with natural phrasing and correct English grammar.
   - Skip trivial nitpicks. Focus on merge-blocking issues and provide concrete code snippet fixes.
4. **Separate PR Reviews**:
   - You MUST provide a dedicated review item in "prReviews" for EACH repository, with its own specific verdict, summary, and list of comments.

Respond ONLY with valid JSON strictly adhering to this schema:
{
  "summary": "Unified executive overview of the coordinated full-stack changes...",
  "crossRepoAnalysis": "Detailed analysis of Web <-> API contract compatibility, endpoint matching, type synchronization, and deployment notes...",
  "breakingChangeWarnings": [
    "Warning: API renamed 'company_id' to 'companyId', but Web still accesses 'response.company_id'"
  ],
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "prReviews": [
${prs
  .map(
    (p) => `    {
      "repo": "${p.repo}",
      "pullNumber": ${p.pullNumber},
      "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
      "summary": "Specific review summary for ${p.repo}...",
      "comments": [
        {
          "repo": "${p.repo}",
          "path": "path/to/file.ts",
          "line": 42,
          "body": "Natural, helpful comment with concrete code suggestion..."
        }
      ]
    }`
  )
  .join(",\n")}
  ],
  "comments": [
    {
      "repo": "${prs[0].repo}",
      "path": "path/to/file.ts",
      "line": 42,
      "body": "Comment..."
    }
  ]
}
`;

  try {
    const responseText = await generateReviewWithFallback(prompt);
    const parsed = JSON.parse(responseText);

    // Normalize per-PR reviews and comments
    const prReviews: SinglePRReviewResult[] = [];
    const allComments: any[] = [];

    if (Array.isArray(parsed.prReviews)) {
      for (const pr of prs) {
        const found = parsed.prReviews.find(
          (r: any) => String(r.repo).toLowerCase() === pr.repo.toLowerCase()
        );
        const repoComments = Array.isArray(found?.comments)
          ? found.comments.map((c: any) => ({ ...c, repo: pr.repo }))
          : [];

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
          comments: repoComments,
        });

        allComments.push(...repoComments);
      }
    }

    // If root comments has items not in per-PR reviews, merge them
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (!allComments.some((existing) => existing.path === c.path && existing.line === c.line)) {
          allComments.push(c);
          // Also associate with matching prReview
          const matchingPR = prReviews.find(
            (p) => p.repo.toLowerCase() === String(c.repo || "").toLowerCase()
          );
          if (matchingPR) {
            matchingPR.comments.push(c);
          }
        }
      }
    }

    return {
      summary: parsed.summary || "Coordinated review completed. No major issues observed.",
      crossRepoAnalysis: parsed.crossRepoAnalysis,
      breakingChangeWarnings: Array.isArray(parsed.breakingChangeWarnings) ? parsed.breakingChangeWarnings : [],
      verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.verdict)
        ? parsed.verdict
        : "COMMENT",
      prReviews,
      comments: allComments,
    };
  } catch (error: any) {
    console.error("Gemini Paired Review Error:", error);
    return {
      summary: `Automated paired review failed to parse: ${error.message || "Unknown error"}`,
      verdict: "COMMENT",
      comments: [],
    };
  }
}



