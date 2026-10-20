import { PendingReview, PRInfo, SinglePRReviewResult } from "./types.js";

export interface ReviewSubmissionItem {
  prTitle: string;
  prUrl: string;
  githubReviewUrl: string;
  repo?: string;
  pullNumber?: number;
}

/**
 * Builds the Slack Block Kit UI for the high-level overview of a paired PR review.
 * Displays the cross-repository breaking change check, contract analysis, and batch actions.
 */
export function buildPairedOverviewBlocks(review: PendingReview) {
  const { prInfos, reviewResult, id } = review;
  const prs = prInfos || [review.prInfo];

  const verdictEmoji =
    reviewResult.verdict === "APPROVE"
      ? "🟢 APPROVE"
      : reviewResult.verdict === "REQUEST_CHANGES"
      ? "🔴 REQUEST CHANGES"
      : "💬 COMMENT ONLY";

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔗 Paired Review: Full-Stack Overview & Breaking Code Audit",
        emoji: true,
      },
    },
  ];

  const prsListText = prs
    .map((p, idx) => {
      const tag = p.label ? `*[${p.label}]* ` : "";
      return `• ${tag}<${p.url}|${p.owner}/${p.repo}#${p.pullNumber}>: *${p.title}* (by @${p.author})`;
    })
    .join("\n");

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Linked Pull Requests:*\n${prsListText}\n\n*Overall AI Suggested Verdict:* *${verdictEmoji}*`,
    },
  });

  blocks.push({
    type: "divider",
  });

  // Breaking Code Warnings
  if (reviewResult.breakingChangeWarnings && reviewResult.breakingChangeWarnings.length > 0) {
    const warnings = reviewResult.breakingChangeWarnings.map((w) => `• ⚠️ ${w}`).join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🚨 POTENTIAL BREAKING CODE DETECTED:*\n${warnings}`,
      },
    });
    blocks.push({
      type: "divider",
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🛡️ Breaking Code Audit:* No contract breakages, endpoint mismatches, or schema drift detected between Web and API.`,
      },
    });
    blocks.push({
      type: "divider",
    });
  }

  // Cross-Repo Analysis
  if (reviewResult.crossRepoAnalysis) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🔄 API Contract & Cross-Repository Compatibility:*\n${reviewResult.crossRepoAnalysis}`,
      },
    });
    blocks.push({
      type: "divider",
    });
  }

  // Executive Summary
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*📝 Full-Stack Summary:*\n${reviewResult.summary}`,
    },
  });

  blocks.push(
    {
      type: "divider",
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `✅ Approve Both PRs (${prs.length})`,
            emoji: true,
          },
          style: "primary",
          action_id: "btn_approve_review",
          value: id,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `💬 Post Comments to Both PRs`,
            emoji: true,
          },
          action_id: "btn_comment_review",
          value: id,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "❌ Discard Both",
            emoji: true,
          },
          style: "danger",
          action_id: "btn_discard_review",
          value: id,
        },
      ],
    }
  );

  return blocks;
}

/**
 * Builds the Slack Block Kit UI for an INDIVIDUAL repository's review and issue comments.
 * Delivered separately to the reviewer so comments can be inspected and approved per PR.
 */
export function buildSinglePRApprovalBlocks(review: PendingReview, prIndex: number) {
  const { id } = review;
  const prs = review.prInfos && review.prInfos.length > 0 ? review.prInfos : [review.prInfo];
  const pr = prs[prIndex] || prs[0];

  // Find dedicated review result for this PR
  const prReview = review.reviewResult.prReviews?.find(
    (r) => r.repo.toLowerCase() === pr.repo.toLowerCase()
  );

  const verdict = prReview?.verdict || review.reviewResult.verdict;
  const verdictEmoji =
    verdict === "APPROVE"
      ? "🟢 APPROVE"
      : verdict === "REQUEST_CHANGES"
      ? "🔴 REQUEST CHANGES"
      : "💬 COMMENT ONLY";

  // Filter comments specifically for this PR
  const comments =
    prReview?.comments && prReview.comments.length > 0
      ? prReview.comments
      : review.reviewResult.comments.filter(
          (c) => !c.repo || c.repo.toLowerCase() === pr.repo.toLowerCase()
        );

  const roleLabel = pr.label ? `[${pr.label}] ` : "";

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📁 ${roleLabel}${pr.repo}#${pr.pullNumber} Review Draft`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Pull Request:*\n<${pr.url}|#${pr.pullNumber} - ${pr.title}>`,
        },
        {
          type: "mrkdwn",
          text: `*Author:*\n@${pr.author}`,
        },
        {
          type: "mrkdwn",
          text: `*Repository:*\n\`${pr.owner}/${pr.repo}\``,
        },
        {
          type: "mrkdwn",
          text: `*Suggested Verdict:*\n*${verdictEmoji}*`,
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📝 Review Summary:*\n${prReview?.summary || review.reviewResult.summary}`,
      },
    },
  ];

  // Format this PR's issue comments separately
  if (comments.length > 0) {
    blocks.push({
      type: "divider",
    });

    let commentsText = `*💬 Issue Comments for \`${pr.repo}\` (${comments.length}):*\n`;
    for (const [index, c] of comments.entries()) {
      commentsText += `\n*${index + 1}. \`${c.path}:${c.line}\`*\n> ${c.body.replace(/\n/g, "\n> ")}\n`;
    }

    if (commentsText.length > 2900) {
      commentsText = commentsText.slice(0, 2800) + "\n\n_...comments truncated due to length._";
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: commentsText,
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*💬 Comments:* No inline defects or blocking comments for \`${pr.repo}\`.`,
      },
    });
  }

  const buttonPayload = `${id}:${prIndex}`;

  blocks.push(
    {
      type: "divider",
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `✅ Approve ${pr.label || pr.repo}`,
            emoji: true,
          },
          style: "primary",
          action_id: "btn_approve_single",
          value: buttonPayload,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `💬 Post Comments ${pr.label || pr.repo}`,
            emoji: true,
          },
          action_id: "btn_comment_single",
          value: buttonPayload,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `❌ Discard ${pr.label || pr.repo}`,
            emoji: true,
          },
          style: "danger",
          action_id: "btn_discard_single",
          value: buttonPayload,
        },
      ],
    }
  );

  return blocks;
}

/**
 * Builds the Slack Block Kit UI for a single PR review approval DM.
 */
export function buildReviewApprovalBlocks(review: PendingReview) {
  return buildSinglePRApprovalBlocks(review, 0);
}

/**
 * Builds confirmation blocks after reviews have been submitted to GitHub.
 */
export function buildReviewSubmittedBlocks(
  itemsOrTitle: string | ReviewSubmissionItem[],
  prUrl?: string,
  githubReviewUrl?: string,
  actionText: string = "✅ Approved and Posted to GitHub"
) {
  if (Array.isArray(itemsOrTitle)) {
    const list = itemsOrTitle
      .map(
        (item) =>
          `• *${item.repo ? `\`${item.repo}\`: ` : ""}<${item.prUrl}|${item.prTitle}>*\n  🔗 <${item.githubReviewUrl}|View Published Review on GitHub>`
      )
      .join("\n\n");

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${actionText}*\n\n${list}`,
        },
      },
    ];
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${actionText}* for <${prUrl}|${itemsOrTitle}>\n\n🔗 <${githubReviewUrl}|View Published Review on GitHub>`,
      },
    },
  ];
}


