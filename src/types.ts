export interface PRInfo {
  owner: string;
  repo: string;
  pullNumber: number;
  url: string;
  title: string;
  description: string;
  author: string;
  label?: string; // e.g. "Web", "API", "Frontend", "Backend"
  files: Array<{
    filename: string;
    patch?: string;
    additions: number;
    deletions: number;
  }>;
}

export interface ReviewComment {
  repo?: string; // target repository in multi-PR reviews
  path: string;
  line: number;
  body: string;
}

export interface SinglePRReviewResult {
  repo: string;
  pullNumber: number;
  title?: string;
  url?: string;
  author?: string;
  label?: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  summary: string;
  comments: ReviewComment[];
}

export interface AIReviewResult {
  summary: string;
  crossRepoAnalysis?: string;
  breakingChangeWarnings?: string[];
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  prReviews?: SinglePRReviewResult[];
  comments: ReviewComment[];
}

export interface PendingReview {
  id: string;
  prInfo: PRInfo;
  prInfos?: PRInfo[];
  isPaired?: boolean;
  reviewResult: AIReviewResult;
  channelId?: string;
  threadTs?: string;
  requestedBy?: string;
  createdAt: Date;
  statusByRepo?: Record<string, "pending" | "approved" | "commented" | "discarded">;
}


