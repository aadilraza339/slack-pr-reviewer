#!/usr/bin/env npx tsx
/**
 * Standalone PR context + optional CI runner (for hosted slack-pr-reviewer or local debugging).
 *
 * Examples:
 *   npx tsx scripts/pr-review-check.ts --context https://github.com/org/peoplefirst-api/pull/2982
 *   npx tsx scripts/pr-review-check.ts --ci --paired \
 *     https://github.com/org/peoplefirst-web/pull/3216 \
 *     https://github.com/org/peoplefirst-api/pull/2982
 */
import "dotenv/config";
import { parseAllPRUrls } from "../src/github.js";
import { ensureGitHubAuth } from "../src/githubAuth.js";
import { fetchPRDetails } from "../src/github.js";
import { runPrCiCheck, assertCiPrerequisites } from "../src/prCiCheck.js";

function parseArgs(argv: string[]) {
  const wantsContext = argv.includes("--context") || argv.includes("--context-only");
  const runCi = argv.includes("--ci");
  const json = argv.includes("--json");
  const urls = argv.filter((a) => a.includes("github.com") && a.includes("/pull/"));

  if (!wantsContext && !runCi) {
    console.error("Pass --context and/or --ci plus one or more PR URLs.");
    process.exit(1);
  }
  if (urls.length === 0) {
    console.error("No PR URLs found in arguments.");
    process.exit(1);
  }

  return { wantsContext, runCi, json, urls: parseAllPRUrls(urls.join("\n")) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureGitHubAuth();

  if (args.runCi) {
    process.env.PR_REVIEW_RUN_CI = "true";
    await assertCiPrerequisites();
  }

  const results: Record<string, unknown>[] = [];

  for (const ref of args.urls) {
    const entry: Record<string, unknown> = {
      repo: ref.repo,
      pullNumber: ref.pullNumber,
      url: ref.url,
    };

    if (args.wantsContext) {
      const pr = await fetchPRDetails(ref.owner, ref.repo, ref.pullNumber, ref.label);
      entry.changedFiles = pr.files.length;
      entry.relatedContext = (pr.relatedContext ?? []).map((r) => ({
        file: r.filename,
        reason: r.reason,
        chars: r.content.length,
      }));
    }

    if (args.runCi) {
      const ci = await runPrCiCheck(ref.owner, ref.repo, ref.pullNumber);
      entry.ci = {
        status: ci.status,
        commandsRun: ci.commandsRun,
        logTail: ci.log.slice(-4000),
      };
    }

    results.push(entry);
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n=== ${r.repo}#${r.pullNumber} ===`);
      if (r.relatedContext) {
        console.log(`Changed files: ${r.changedFiles}`);
        console.log("Related context:");
        for (const c of r.relatedContext as Array<{ file: string; reason: string }>) {
          console.log(`  • ${c.file} — ${c.reason}`);
        }
      }
      if (r.ci) {
        const ci = r.ci as { status: string; commandsRun: string[] };
        console.log(`CI: ${ci.status} (${ci.commandsRun.join(", ") || "n/a"})`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
