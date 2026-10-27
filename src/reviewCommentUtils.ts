import { ReviewComment, ReviewCommentSeverity } from "./types.js";

export function normalizeCommentSeverity(raw: unknown): ReviewCommentSeverity {
  if (raw === "suggestion" || raw === "blocking") return raw;
  return "blocking";
}

export function hasBlockingComments(comments: ReviewComment[]): boolean {
  return comments.some((c) => (c.severity ?? "blocking") === "blocking");
}

/** GitHub inline comment body with tier label (Viswesh-style staff review). */
export function formatCommentBodyForGitHub(comment: ReviewComment): string {
  const severity = comment.severity ?? "blocking";
  if (severity === "suggestion") {
    return `**Suggestion:** ${comment.body}`;
  }
  return comment.body;
}

export function computeVerdictFromComments(
  comments: ReviewComment[],
  modelVerdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (hasBlockingComments(comments)) {
    return "REQUEST_CHANGES";
  }
  if (comments.some((c) => (c.severity ?? "blocking") === "suggestion")) {
    return modelVerdict === "APPROVE" ? "COMMENT" : modelVerdict;
  }
  return modelVerdict;
}

export function partitionComments(comments: ReviewComment[]): {
  blocking: ReviewComment[];
  suggestions: ReviewComment[];
} {
  const blocking: ReviewComment[] = [];
  const suggestions: ReviewComment[] = [];
  for (const c of comments) {
    if ((c.severity ?? "blocking") === "suggestion") {
      suggestions.push(c);
    } else {
      blocking.push(c);
    }
  }
  return { blocking, suggestions };
}
