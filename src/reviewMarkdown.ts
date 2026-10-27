/** Normalize AI-generated markdown before posting to GitHub reviews / inline comments. */
export function cleanReviewMarkdown(input: string, maxLength = 60_000): string {
  if (!input) return "";

  let text = input.replace(/\r\n/g, "\n").trim();
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/\n{4,}/g, "\n\n\n");

  // Drop orphaned triple-backtick lines (unbalanced fences break GitHub rendering)
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    text = text.replace(/\n?```[^\n]*$/, "");
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 24)}\n\n_[truncated for GitHub limit]_`;
  }

  return text;
}

export interface PullRequestReviewCommentPayload {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface PullRequestReviewPayload {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments?: PullRequestReviewCommentPayload[];
}

export function buildPullRequestReviewPayload(
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  summary: string,
  comments: Array<{ path: string; line: number; body: string }>
): PullRequestReviewPayload {
  const formattedComments: PullRequestReviewCommentPayload[] = comments
    .filter((c) => c.path && c.line && c.body)
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      body: cleanReviewMarkdown(c.body, 65_000),
    }));

  const payload: PullRequestReviewPayload = {
    event,
    body: cleanReviewMarkdown(summary),
  };

  if (formattedComments.length > 0) {
    payload.comments = formattedComments;
  }

  return payload;
}
