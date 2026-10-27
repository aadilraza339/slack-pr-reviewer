import { parseAllPRUrls } from "../src/github.js";
import { buildPullRequestReviewPayload, cleanReviewMarkdown } from "../src/reviewMarkdown.js";
import {
  buildReviewApprovalBlocks,
  buildPairedOverviewBlocks,
  buildSinglePRApprovalBlocks,
  buildReviewSubmittedBlocks,
} from "../src/slackBlocks.js";
import { PendingReview } from "../src/types.js";

function runTests() {
  console.log("Running paired PR tests...");

  // Test 1: User provided example
  const input = `
web: https://github.com/wysbryxtech/peoplefirst-web/pull/3167
api: https://github.com/wysbryxtech/peoplefirst-api/pull/2925
  `;

  const parsed = parseAllPRUrls(input);
  console.log("Test 1 parsed count:", parsed.length);
  if (parsed.length !== 2) {
    throw new Error(`Expected 2 PRs, got ${parsed.length}`);
  }

  if (parsed[0].repo !== "peoplefirst-web" || parsed[0].pullNumber !== 3167) {
    throw new Error(`Unexpected PR 1: ${JSON.stringify(parsed[0])}`);
  }

  if (parsed[1].repo !== "peoplefirst-api" || parsed[1].pullNumber !== 2925) {
    throw new Error(`Unexpected PR 2: ${JSON.stringify(parsed[1])}`);
  }

  if (parsed[0].label !== "web" || parsed[1].label !== "api") {
    throw new Error(`Labels mismatch: ${parsed[0].label}, ${parsed[1].label}`);
  }
  console.log("✓ Test 1: User's paired web & api links parsed correctly.");

  // Test 2: Slack formatted links without explicit label prefix
  const inputSlack = "Please review <https://github.com/wysbryxtech/peoplefirst-web/pull/1234|PR 1234> and <https://github.com/wysbryxtech/peoplefirst-api/pull/5678>";
  const parsedSlack = parseAllPRUrls(inputSlack);
  if (parsedSlack.length !== 2) {
    throw new Error(`Expected 2 Slack PRs, got ${parsedSlack.length}`);
  }
  if (parsedSlack[0].label !== "Web / Frontend" || parsedSlack[1].label !== "API / Backend") {
    throw new Error(`Inferred labels mismatch: ${parsedSlack[0].label}, ${parsedSlack[1].label}`);
  }
  console.log("✓ Test 2: Inferred labels from repo names (Web & API) succeeded.");

  // Test 3: Slack Block Kit rendering for paired PRs
  const mockReview: PendingReview = {
    id: "test-review-id",
    isPaired: true,
    prInfo: {
      owner: "wysbryxtech",
      repo: "peoplefirst-web",
      pullNumber: 3167,
      url: "https://github.com/wysbryxtech/peoplefirst-web/pull/3167",
      title: "Offer letter template multi-page preview",
      description: "Added page breaks and headers",
      author: "aadil",
      label: "web",
      files: [],
    },
    prInfos: [
      {
        owner: "wysbryxtech",
        repo: "peoplefirst-web",
        pullNumber: 3167,
        url: "https://github.com/wysbryxtech/peoplefirst-web/pull/3167",
        title: "Offer letter template multi-page preview",
        description: "Added page breaks and headers",
        author: "aadil",
        label: "web",
        files: [],
      },
      {
        owner: "wysbryxtech",
        repo: "peoplefirst-api",
        pullNumber: 2925,
        url: "https://github.com/wysbryxtech/peoplefirst-api/pull/2925",
        title: "Job offer template code generation and asset presigning",
        description: "Fixed template code sync and presigned URLs",
        author: "aadil",
        label: "api",
        files: [],
      },
    ],
    reviewResult: {
      summary: "Both PRs deliver the multi-page offer letter experience seamlessly.",
      crossRepoAnalysis: "Web API client matches the updated endpoints and response schemas.",
      verdict: "APPROVE",
      comments: [
        {
          repo: "peoplefirst-web",
          path: "src/PageBreakView.tsx",
          line: 45,
          body: "Consider memoizing page index calculation.",
        },
        {
          repo: "peoplefirst-api",
          path: "src/services/offerTemplates.ts",
          line: 110,
          body: "Ensure validation error messages are logged.",
        },
      ],
    },
    createdAt: new Date(),
  };

  const overviewBlocks = buildPairedOverviewBlocks(mockReview);
  if (!overviewBlocks || overviewBlocks.length === 0) {
    throw new Error("Overview blocks failed to generate");
  }

  // Verify Web PR separate blocks
  const webBlocks = buildSinglePRApprovalBlocks(mockReview, 0);
  const webBlocksStr = JSON.stringify(webBlocks);
  if (!webBlocksStr.includes("peoplefirst-web") || !webBlocksStr.includes("src/PageBreakView.tsx")) {
    throw new Error("Web blocks missing web comments");
  }
  if (webBlocksStr.includes("peoplefirst-api") || webBlocksStr.includes("src/services/offerTemplates.ts")) {
    throw new Error("Web blocks incorrectly leaked API comments");
  }

  // Verify API PR separate blocks
  const apiBlocks = buildSinglePRApprovalBlocks(mockReview, 1);
  const apiBlocksStr = JSON.stringify(apiBlocks);
  if (!apiBlocksStr.includes("peoplefirst-api") || !apiBlocksStr.includes("src/services/offerTemplates.ts")) {
    throw new Error("API blocks missing API comments");
  }
  if (apiBlocksStr.includes("src/PageBreakView.tsx")) {
    throw new Error("API blocks incorrectly leaked Web comments");
  }

  const submitted = buildReviewSubmittedBlocks([
    {
      prTitle: "Web PR",
      prUrl: "https://github.com/wysbryxtech/peoplefirst-web/pull/3167",
      githubReviewUrl: "https://github.com/wysbryxtech/peoplefirst-web/pull/3167#pullrequestreview-1",
      repo: "peoplefirst-web",
      pullNumber: 3167,
    },
    {
      prTitle: "API PR",
      prUrl: "https://github.com/wysbryxtech/peoplefirst-api/pull/2925",
      githubReviewUrl: "https://github.com/wysbryxtech/peoplefirst-api/pull/2925#pullrequestreview-2",
      repo: "peoplefirst-api",
      pullNumber: 2925,
    },
  ]);
  if (!submitted || submitted.length === 0) {
    throw new Error("Submitted blocks failed to generate");
  }
  console.log("✓ Test 3: Slack block generation for paired reviews and separate per-PR issue comments verified.");

  const cleaned = cleanReviewMarkdown("  hello\r\n\r\n\n\n\nworld ```broken");
  if (!cleaned.includes("hello") || cleaned.includes("\r")) {
    throw new Error(`Markdown clean failed: ${JSON.stringify(cleaned)}`);
  }

  const payload = buildPullRequestReviewPayload("COMMENT", "## Summary", [
    { path: "src/a.ts", line: 10, body: "Fix **this**" },
  ]);
  if (payload.event !== "COMMENT" || payload.comments?.length !== 1 || payload.comments[0].side !== "RIGHT") {
    throw new Error(`Review JSON payload invalid: ${JSON.stringify(payload)}`);
  }
  console.log("✓ Test 4: Review markdown cleaning and JSON payload shape verified.");

  console.log("\nALL TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests();

