import { Octokit } from "@octokit/rest";
import { PRInfo, ReviewComment } from "./types.js";

const GITHUB_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
const octokit = new Octokit({ auth: GITHUB_TOKEN });

export interface ParsedPRReference {
  owner: string;
  repo: string;
  pullNumber: number;
  url: string;
  label?: string;
}

/**
 * Parses all GitHub PR URLs in a message to extract owner, repo, pull number, and optional label.
 * Supports paired PR requests like:
 *   web: https://github.com/wysbryxtech/peoplefirst-web/pull/3167
 *   api: https://github.com/wysbryxtech/peoplefirst-api/pull/2925
 */
export function parseAllPRUrls(text: string): ParsedPRReference[] {
  const results: ParsedPRReference[] = [];
  const seenKeys = new Set<string>();

  // Check lines first to capture explicit labels (e.g. "web:", "api:", "frontend:")
  const lines = text.split(/\r?\n/);
  const prRegex = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s<>|]+)\/([^/\s<>|]+)\/pull\/(\d+)/gi;

  for (const line of lines) {
    const labelMatch = line.match(/^\s*([a-zA-Z0-9_\-\s]+?)\s*:\s*(https?:\/\/.*)/i);
    const lineLabel = labelMatch ? labelMatch[1].trim() : undefined;

    let match: RegExpExecArray | null;
    while ((match = prRegex.exec(line)) !== null) {
      const owner = match[1];
      const repo = match[2];
      const pullNumber = parseInt(match[3], 10);
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${pullNumber}`;

      if (!seenKeys.has(key)) {
        seenKeys.add(key);

        let label = lineLabel;
        if (!label) {
          if (/web|front/i.test(repo)) label = "Web / Frontend";
          else if (/api|back|srv|server/i.test(repo)) label = "API / Backend";
        }

        results.push({
          owner,
          repo,
          pullNumber,
          url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
          label,
        });
      }
    }
  }

  // Also catch any PR URLs that might not have been on line boundaries
  let globalMatch: RegExpExecArray | null;
  const globalRegex = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s<>|]+)\/([^/\s<>|]+)\/pull\/(\d+)/gi;
  while ((globalMatch = globalRegex.exec(text)) !== null) {
    const owner = globalMatch[1];
    const repo = globalMatch[2];
    const pullNumber = parseInt(globalMatch[3], 10);
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${pullNumber}`;

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      let label: string | undefined;
      if (/web|front/i.test(repo)) label = "Web / Frontend";
      else if (/api|back|srv|server/i.test(repo)) label = "API / Backend";

      results.push({
        owner,
        repo,
        pullNumber,
        url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
        label,
      });
    }
  }

  return results;
}

/**
 * Parses single GitHub PR URL to extract owner, repo, and pull number.
 * Example: https://github.com/facebook/react/pull/1234
 */
export function parsePRUrl(url: string): { owner: string; repo: string; pullNumber: number } | null {
  const prs = parseAllPRUrls(url);
  if (prs.length === 0) return null;
  return {
    owner: prs[0].owner,
    repo: prs[0].repo,
    pullNumber: prs[0].pullNumber,
  };
}

/**
 * Fetches pull request details, changed files, and code patches.
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  pullNumber: number,
  label?: string
): Promise<PRInfo> {
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 50,
  });

  // Filter out lock files or binary files to keep tokens clean
  const relevantFiles = files
    .filter((f) => !f.filename.endsWith(".lock") && !f.filename.endsWith("-lock.json"))
    .map((f) => ({
      filename: f.filename,
      patch: f.patch,
      additions: f.additions,
      deletions: f.deletions,
    }));

  return {
    owner,
    repo,
    pullNumber,
    url: pr.html_url,
    title: pr.title,
    description: pr.body || "No description provided.",
    author: pr.user.login,
    label: label || (/web|front/i.test(repo) ? "Web / Frontend" : /api|back|srv/i.test(repo) ? "API / Backend" : undefined),
    files: relevantFiles,
  };
}

/**
 * Submits the final review to GitHub under YOUR personal identity.
 */
export async function submitGitHubReview(
  owner: string,
  repo: string,
  pullNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  summary: string,
  comments: ReviewComment[]
): Promise<string> {
  // Format overall review body
  let reviewBody = summary;

  // Format valid inline comments
  const formattedComments = comments
    .filter((c) => c.path && c.line && c.body)
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      body: c.body,
    }));

  try {
    const { data: review } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event,
      body: reviewBody,
      comments: formattedComments,
    });
    return review.html_url;
  } catch (error: any) {
    // If GitHub rejects batch inline comments due to line number diff mismatch,
    // fallback to posting the summary with inline comments appended as markdown
    console.warn("Batch inline comment failed, falling back to summary review:", error.message);

    let fallbackBody = reviewBody + "\n\n### 💬 Detailed Comments:\n";
    for (const c of comments) {
      fallbackBody += `\n- **\`${c.path}:${c.line}\`**: ${c.body}`;
    }

    const { data: review } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event,
      body: fallbackBody,
    });
    return review.html_url;
  }
}
