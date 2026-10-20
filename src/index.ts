import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import { parsePRUrl, parseAllPRUrls, fetchPRDetails, submitGitHubReview } from "./github.js";
import { generatePRReview, generatePairedPRReview } from "./ai.js";
import {
  buildReviewApprovalBlocks,
  buildPairedOverviewBlocks,
  buildSinglePRApprovalBlocks,
  buildReviewSubmittedBlocks,
  ReviewSubmissionItem,
} from "./slackBlocks.js";
import { PendingReview, PRInfo } from "./types.js";

// Validate essential environment variables
const requiredEnvVars = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_REVIEWER_USER_ID",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GEMINI_API_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`⚠️ Warning: Missing environment variable ${envVar}. Check your .env file.`);
  }
}

// In-memory store for reviews awaiting approval
const pendingReviews = new Map<string, PendingReview>();

// Initialize Slack Bolt App with Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

/**
 * Common handler when PR URLs (single or paired) are detected in a message or mention
 */
async function handlePRRequest(text: string, channelId: string, threadTs?: string, requestedBy?: string) {
  const prList = parseAllPRUrls(text);
  if (prList.length === 0) return;

  const isPaired = prList.length > 1;

  if (isPaired) {
    console.log(
      `Detected paired PRs (${prList.length}): ${prList.map((p) => `${p.owner}/${p.repo}#${p.pullNumber}`).join(", ")} requested by ${requestedBy || "unknown"}`
    );
  } else {
    console.log(
      `Detected single PR: ${prList[0].owner}/${prList[0].repo}#${prList[0].pullNumber} requested by ${requestedBy || "unknown"}`
    );
  }

  // Notify in thread that processing has started
  try {
    const prLinks = prList
      .map((p) => `<${p.url}|${p.label ? `[${p.label}] ` : ""}${p.owner}/${p.repo}#${p.pullNumber}>`)
      .join(" and ");

    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: isPaired
        ? `👀 Analyzing paired full-stack PRs ${prLinks} for breaking code, API contract compatibility, and code quality...`
        : `👀 Analyzing PR ${prLinks} and generating an AI review draft...`,
    });
  } catch (err) {
    console.error("Failed to post progress message:", err);
  }

  try {
    // 1. Fetch details for all PRs concurrently from GitHub
    const prInfos: PRInfo[] = await Promise.all(
      prList.map((ref) => fetchPRDetails(ref.owner, ref.repo, ref.pullNumber, ref.label))
    );

    // 2. Generate review using Gemini (paired cross-repo review or single review)
    const reviewResult = isPaired
      ? await generatePairedPRReview(prInfos)
      : await generatePRReview(prInfos[0]);

    // 3. Store pending review
    const reviewId = randomUUID();
    const pendingReview: PendingReview = {
      id: reviewId,
      prInfo: prInfos[0],
      prInfos,
      isPaired,
      reviewResult,
      channelId,
      threadTs,
      requestedBy,
      createdAt: new Date(),
      statusByRepo: {},
    };
    pendingReviews.set(reviewId, pendingReview);

    // 4. Send interactive DM to the Reviewer (YOU) for approval
    const reviewerUserId = process.env.SLACK_REVIEWER_USER_ID;
    if (!reviewerUserId) {
      throw new Error("SLACK_REVIEWER_USER_ID is not configured.");
    }

    if (isPaired) {
      // 4a. Send Full-Stack Overview & Breaking Code Audit Card
      await app.client.chat.postMessage({
        channel: reviewerUserId,
        text: `🔗 Paired AI Review Draft: ${prInfos.map((p) => `${p.repo}#${p.pullNumber}`).join(" & ")}`,
        blocks: buildPairedOverviewBlocks(pendingReview),
      });

      // 4b. Send SEPARATE Issue Comments & Approval DMs for EACH PR
      for (let i = 0; i < prInfos.length; i++) {
        const pr = prInfos[i];
        await app.client.chat.postMessage({
          channel: reviewerUserId,
          text: `📁 ${pr.label ? `[${pr.label}] ` : ""}${pr.repo}#${pr.pullNumber} Review & Issue Comments`,
          blocks: buildSinglePRApprovalBlocks(pendingReview, i),
        });
      }
    } else {
      // Single PR approval
      await app.client.chat.postMessage({
        channel: reviewerUserId,
        text: `AI Review Draft ready for ${prInfos[0].title}`,
        blocks: buildReviewApprovalBlocks(pendingReview),
      });
    }

    // 5. Notify the original thread that approval is pending
    if (channelId && threadTs) {
      const threadNotice = isPaired
        ? `✅ Paired AI review drafts & breaking change audit generated and sent to <@${reviewerUserId}> with separate comment breakdowns for approval.`
        : `✅ AI review draft generated and sent to <@${reviewerUserId}> for review & approval before posting to GitHub.`;

      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: threadNotice,
      });
    }
  } catch (error: any) {
    console.error("Error processing PR review:", error);
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `❌ Could not generate review for PR: ${error.message || "Unknown error"}`,
    });
  }
}


// Listen for mentions (@bot https://github.com/...)
app.event("app_mention", async ({ event, say }) => {
  const text = event.text;
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const user = event.user;

  await handlePRRequest(text, channel, threadTs, user);
});

// Listen for regular messages containing github pull request URLs
app.message(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i, async ({ message, say }) => {
  // Ignore bot messages to prevent loops
  if ("bot_id" in message) return;

  const text = "text" in message ? message.text || "" : "";
  const channel = message.channel;
  const threadTs = "thread_ts" in message ? (message as any).thread_ts : message.ts;
  const user = "user" in message ? (message as any).user : undefined;

  await handlePRRequest(text, channel, threadTs, user);
});

// Helper to parse reviewId and prIndex
function parseSingleActionValue(value: string) {
  const parts = value.split(":");
  return {
    reviewId: parts[0],
    prIndex: parseInt(parts[1] || "0", 10),
  };
}

// Handle Button Click: "Approve Single PR" (e.g. Web or API individually)
app.action("btn_approve_single", async ({ action, ack, respond }) => {
  await ack();
  const { reviewId, prIndex } = parseSingleActionValue((action as any).value);
  const review = pendingReviews.get(reviewId);

  if (!review) {
    await respond({ text: "⚠️ Review session expired or not found.", replace_original: false });
    return;
  }

  const prs = review.prInfos && review.prInfos.length > 0 ? review.prInfos : [review.prInfo];
  const pr = prs[prIndex] || prs[0];
  const reviewerUserId = process.env.SLACK_REVIEWER_USER_ID;

  try {
    const prReview = review.reviewResult.prReviews?.find(
      (r) => r.repo.toLowerCase() === pr.repo.toLowerCase()
    );

    let reviewBody = prReview?.summary || review.reviewResult.summary;
    if (review.isPaired && review.reviewResult.crossRepoAnalysis) {
      reviewBody = `### 🔄 Coordinated Cross-Repo & API Compatibility Review (${pr.label || pr.repo})\n\n${review.reviewResult.crossRepoAnalysis}\n\n### 📝 Review Summary\n${reviewBody}`;
    }

    const prComments =
      prReview?.comments && prReview.comments.length > 0
        ? prReview.comments
        : review.reviewResult.comments.filter(
            (c) => !c.repo || c.repo.toLowerCase() === pr.repo.toLowerCase()
          );

    const githubReviewUrl = await submitGitHubReview(
      pr.owner,
      pr.repo,
      pr.pullNumber,
      "APPROVE",
      reviewBody,
      prComments
    );

    if (review.statusByRepo) {
      review.statusByRepo[pr.repo] = "approved";
    }

    await respond({
      blocks: buildReviewSubmittedBlocks(
        pr.title,
        pr.url,
        githubReviewUrl,
        `✅ Approved & Posted to GitHub for ${pr.label ? `[${pr.label}] ` : ""}${pr.repo}#${pr.pullNumber}`
      ),
      replace_original: true,
    });

    if (review.channelId) {
      await app.client.chat.postMessage({
        channel: review.channelId,
        thread_ts: review.threadTs,
        text: `🎉 Review for *${pr.label ? `[${pr.label}] ` : ""}${pr.repo}#${pr.pullNumber}* approved by <@${reviewerUserId}>: <${githubReviewUrl}|View on GitHub>`,
      });
    }
  } catch (error: any) {
    console.error(`Error submitting review for ${pr.repo}:`, error);
    await respond({
      text: `❌ Error submitting review for ${pr.repo}: ${error.message}`,
      replace_original: false,
    });
  }
});

// Handle Button Click: "Comment Single PR"
app.action("btn_comment_single", async ({ action, ack, respond }) => {
  await ack();
  const { reviewId, prIndex } = parseSingleActionValue((action as any).value);
  const review = pendingReviews.get(reviewId);

  if (!review) {
    await respond({ text: "⚠️ Review session expired or not found.", replace_original: false });
    return;
  }

  const prs = review.prInfos && review.prInfos.length > 0 ? review.prInfos : [review.prInfo];
  const pr = prs[prIndex] || prs[0];
  const reviewerUserId = process.env.SLACK_REVIEWER_USER_ID;

  try {
    const prReview = review.reviewResult.prReviews?.find(
      (r) => r.repo.toLowerCase() === pr.repo.toLowerCase()
    );

    let reviewBody = prReview?.summary || review.reviewResult.summary;
    if (review.isPaired && review.reviewResult.crossRepoAnalysis) {
      reviewBody = `### 🔄 Coordinated Cross-Repo & API Compatibility Review (${pr.label || pr.repo})\n\n${review.reviewResult.crossRepoAnalysis}\n\n### 📝 Review Summary\n${reviewBody}`;
    }

    const prComments =
      prReview?.comments && prReview.comments.length > 0
        ? prReview.comments
        : review.reviewResult.comments.filter(
            (c) => !c.repo || c.repo.toLowerCase() === pr.repo.toLowerCase()
          );

    const githubReviewUrl = await submitGitHubReview(
      pr.owner,
      pr.repo,
      pr.pullNumber,
      "COMMENT",
      reviewBody,
      prComments
    );

    if (review.statusByRepo) {
      review.statusByRepo[pr.repo] = "commented";
    }

    await respond({
      blocks: buildReviewSubmittedBlocks(
        pr.title,
        pr.url,
        githubReviewUrl,
        `💬 Comments Posted to GitHub for ${pr.label ? `[${pr.label}] ` : ""}${pr.repo}#${pr.pullNumber}`
      ),
      replace_original: true,
    });

    if (review.channelId) {
      await app.client.chat.postMessage({
        channel: review.channelId,
        thread_ts: review.threadTs,
        text: `💬 Review comments for *${pr.label ? `[${pr.label}] ` : ""}${pr.repo}#${pr.pullNumber}* posted by <@${reviewerUserId}>: <${githubReviewUrl}|View on GitHub>`,
      });
    }
  } catch (error: any) {
    console.error(`Error submitting comments for ${pr.repo}:`, error);
    await respond({
      text: `❌ Error submitting comments for ${pr.repo}: ${error.message}`,
      replace_original: false,
    });
  }
});

// Handle Button Click: "Discard Single PR"
app.action("btn_discard_single", async ({ action, ack, respond }) => {
  await ack();
  const { reviewId, prIndex } = parseSingleActionValue((action as any).value);
  const review = pendingReviews.get(reviewId);
  const prs = review?.prInfos && review.prInfos.length > 0 ? review.prInfos : [review?.prInfo];
  const pr = prs[prIndex] || prs[0];

  if (review?.statusByRepo && pr) {
    review.statusByRepo[pr.repo] = "discarded";
  }

  await respond({
    text: `🗑️ Review draft for ${pr?.label ? `[${pr.label}] ` : ""}${pr?.repo || "PR"}#${pr?.pullNumber || ""} discarded. No comments were posted to GitHub.`,
    replace_original: true,
  });
});

// Handle Button Click: "Approve & Post to GitHub" (for single or paired PRs)
app.action("btn_approve_review", async ({ action, ack, respond, body }) => {
  await ack();
  const reviewId = (action as any).value;
  const review = pendingReviews.get(reviewId);

  if (!review) {
    await respond({ text: "⚠️ Review session expired or not found.", replace_original: false });
    return;
  }

  const isPaired = Boolean(review.isPaired && review.prInfos && review.prInfos.length > 1);
  const prsToSubmit = isPaired ? review.prInfos! : [review.prInfo];
  const reviewerUserId = process.env.SLACK_REVIEWER_USER_ID;

  try {
    const submittedItems: ReviewSubmissionItem[] = [];

    for (const pr of prsToSubmit) {
      // Build tailored review body for this PR:
      // Include overall summary + cross-repo compatibility analysis
      let reviewBody = review.reviewResult.summary;
      if (isPaired && review.reviewResult.crossRepoAnalysis) {
        reviewBody = `### 🔄 Coordinated Cross-Repo & API Compatibility Review (${pr.label || pr.repo})\n\n${review.reviewResult.crossRepoAnalysis}\n\n### 📝 Review Summary\n${review.reviewResult.summary}`;
      }

      // Filter inline comments specifically for this PR's repository
      const prComments = review.reviewResult.comments.filter((c) => {
        if (!c.repo) return true;
        return c.repo.toLowerCase() === pr.repo.toLowerCase();
      });

      // Submit review to GitHub
      const githubReviewUrl = await submitGitHubReview(
        pr.owner,
        pr.repo,
        pr.pullNumber,
        "APPROVE",
        reviewBody,
        prComments
      );

      submittedItems.push({
        prTitle: pr.title,
        prUrl: pr.url,
        githubReviewUrl,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
      });
    }

    pendingReviews.delete(reviewId);

    // Update the Slack DM
    const actionLabel = isPaired ? `✅ Approved and Posted to ${prsToSubmit.length} PRs on GitHub` : "✅ Approved and Posted to GitHub";
    await respond({
      blocks: buildReviewSubmittedBlocks(submittedItems, undefined, undefined, actionLabel),
      replace_original: true,
    });

    // Notify original Slack thread
    if (review.channelId) {
      const threadMessage = isPaired
        ? `🎉 Coordinated reviews completed and approved by <@${reviewerUserId}>:\n` +
          submittedItems.map((s) => `• *${s.repo}#${s.pullNumber}*: <${s.githubReviewUrl}|View Published Review on GitHub>`).join("\n")
        : `🎉 Review completed and approved by <@${reviewerUserId}>: <${submittedItems[0].githubReviewUrl}|View on GitHub>`;

      await app.client.chat.postMessage({
        channel: review.channelId,
        thread_ts: review.threadTs,
        text: threadMessage,
      });
    }
  } catch (error: any) {
    console.error("Error submitting review to GitHub:", error);
    await respond({
      text: `❌ Error submitting review to GitHub: ${error.message}`,
      replace_original: false,
    });
  }
});

// Handle Button Click: "Post Comments Only" (for single or paired PRs)
app.action("btn_comment_review", async ({ action, ack, respond }) => {
  await ack();
  const reviewId = (action as any).value;
  const review = pendingReviews.get(reviewId);

  if (!review) {
    await respond({ text: "⚠️ Review session expired or not found.", replace_original: false });
    return;
  }

  const isPaired = Boolean(review.isPaired && review.prInfos && review.prInfos.length > 1);
  const prsToSubmit = isPaired ? review.prInfos! : [review.prInfo];
  const reviewerUserId = process.env.SLACK_REVIEWER_USER_ID;

  try {
    const submittedItems: ReviewSubmissionItem[] = [];

    for (const pr of prsToSubmit) {
      let reviewBody = review.reviewResult.summary;
      if (isPaired && review.reviewResult.crossRepoAnalysis) {
        reviewBody = `### 🔄 Coordinated Cross-Repo & API Compatibility Review (${pr.label || pr.repo})\n\n${review.reviewResult.crossRepoAnalysis}\n\n### 📝 Review Summary\n${review.reviewResult.summary}`;
      }

      const prComments = review.reviewResult.comments.filter((c) => {
        if (!c.repo) return true;
        return c.repo.toLowerCase() === pr.repo.toLowerCase();
      });

      const githubReviewUrl = await submitGitHubReview(
        pr.owner,
        pr.repo,
        pr.pullNumber,
        "COMMENT",
        reviewBody,
        prComments
      );

      submittedItems.push({
        prTitle: pr.title,
        prUrl: pr.url,
        githubReviewUrl,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
      });
    }

    pendingReviews.delete(reviewId);

    // Update Slack DM
    const actionLabel = isPaired ? `💬 Review Comments Posted to ${prsToSubmit.length} PRs on GitHub` : "💬 Review Comments Posted to GitHub";
    await respond({
      blocks: buildReviewSubmittedBlocks(submittedItems, undefined, undefined, actionLabel),
      replace_original: true,
    });

    // Notify original thread
    if (review.channelId) {
      const threadMessage = isPaired
        ? `💬 Coordinated review comments posted to GitHub by <@${reviewerUserId}>:\n` +
          submittedItems.map((s) => `• *${s.repo}#${s.pullNumber}*: <${s.githubReviewUrl}|View Published Review on GitHub>`).join("\n")
        : `💬 Review comments posted to GitHub by <@${reviewerUserId}>: <${submittedItems[0].githubReviewUrl}|View on GitHub>`;

      await app.client.chat.postMessage({
        channel: review.channelId,
        thread_ts: review.threadTs,
        text: threadMessage,
      });
    }
  } catch (error: any) {
    console.error("Error submitting comments to GitHub:", error);
    await respond({
      text: `❌ Error submitting comments to GitHub: ${error.message}`,
      replace_original: false,
    });
  }
});

// Handle Button Click: "Discard"
app.action("btn_discard_review", async ({ action, ack, respond }) => {
  await ack();
  const reviewId = (action as any).value;
  pendingReviews.delete(reviewId);

  await respond({
    text: "🗑️ Review draft discarded. No comments were posted to GitHub.",
    replace_original: true,
  });
});

// Start the Bolt App
(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(port);
  console.log(`⚡️ Slack PR Review Bot is running in Socket Mode!`);
})();
