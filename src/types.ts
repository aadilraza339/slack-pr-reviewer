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

export interface AuditChecklist {
  filesInspectedCount: number;
  breakingChangesStatus: "PASSED" | "FAILED" | "NOT_APPLICABLE";
  databaseNPlusOneStatus: "PASSED" | "FAILED" | "NOT_APPLICABLE";
  tenantIsolationStatus: "PASSED" | "FAILED" | "NOT_APPLICABLE";
  uiDesignTokensStatus: "PASSED" | "FAILED" | "NOT_APPLICABLE";
  confidenceScore: number; // 0 to 100
  auditNotes?: string;
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
  audit?: AuditChecklist;
  comments: ReviewComment[];
}

export interface AIReviewResult {
  summary: string;
  crossRepoAnalysis?: string;
  breakingChangeWarnings?: string[];
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  audit?: AuditChecklist;
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


