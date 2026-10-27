import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolveGitHubToken } from "./githubAuth.js";

const execFileAsync = promisify(execFile);

export interface PrCiCheckResult {
  status: "passed" | "failed" | "skipped" | "error";
  repo: string;
  pullNumber: number;
  headRef?: string;
  commandsRun: string[];
  log: string;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks out PR head in a temp dir and runs build (+ test if present).
 * Requires `gh` and `git` on PATH. Set PR_REVIEW_RUN_CI=true to enable in the Slack bot.
 */
export async function runPrCiCheck(
  owner: string,
  repo: string,
  pullNumber: number,
  headRef?: string
): Promise<PrCiCheckResult> {
  const base: PrCiCheckResult = {
    status: "skipped",
    repo,
    pullNumber,
    headRef,
    commandsRun: [],
    log: "",
  };

  const enabled = process.env.PR_REVIEW_RUN_CI === "true" || process.env.PR_REVIEW_RUN_CI === "1";
  if (!enabled) {
    base.log = "CI skipped (set PR_REVIEW_RUN_CI=true to enable on hosted runner).";
    return base;
  }

  let workDir: string | null = null;
  const logs: string[] = [];

  try {
    const { token } = await resolveGitHubToken();
    const env = {
      ...process.env,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
    };

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-pr-ci-"));
    const repoDir = path.join(workDir, repo);

    logs.push(`Cloning ${owner}/${repo} (depth 1)...`);
    let r = await runCommand("gh", ["repo", "clone", `${owner}/${repo}`, repoDir, "--", "--depth", "1"], workDir, env, 120_000);
    base.commandsRun.push(`gh repo clone ${owner}/${repo}`);
    logs.push(r.stdout + r.stderr);
    if (r.code !== 0) {
      base.status = "error";
      base.log = logs.join("\n");
      return base;
    }

    logs.push(`Checking out PR #${pullNumber}...`);
    r = await runCommand("gh", ["pr", "checkout", String(pullNumber)], repoDir, env, 120_000);
    base.commandsRun.push(`gh pr checkout ${pullNumber}`);
    logs.push(r.stdout + r.stderr);
    if (r.code !== 0) {
      base.status = "error";
      base.log = logs.join("\n");
      return base;
    }

    const pkgPath = path.join(repoDir, "package.json");
    if (!(await pathExists(pkgPath))) {
      base.log = logs.join("\n") + "\nNo package.json — CI skipped.";
      return base;
    }

    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const steps: Array<[string, string[]]> = [];

    if (pkg.scripts?.["ci"]) {
      steps.push(["npm", ["run", "ci"]]);
    } else {
      if (await pathExists(path.join(repoDir, "package-lock.json"))) {
        steps.push(["npm", ["ci"]]);
      } else {
        steps.push(["npm", ["install"]]);
      }
      if (pkg.scripts?.["build"]) steps.push(["npm", ["run", "build"]]);
      if (pkg.scripts?.["test"]) steps.push(["npm", ["run", "test"]]);
      if (pkg.scripts?.["lint"]) steps.push(["npm", ["run", "lint"]]);
    }

    if (steps.length === 0) {
      base.log = logs.join("\n") + "\nNo ci/build/test/lint scripts — skipped.";
      return base;
    }

    for (const [cmd, args] of steps) {
      const label = `${cmd} ${args.join(" ")}`;
      base.commandsRun.push(label);
      logs.push(`\n$ ${label}`);
      r = await runCommand(cmd, args, repoDir, env, 600_000);
      logs.push(r.stdout.slice(-8000) + r.stderr.slice(-4000));
      if (r.code !== 0) {
        base.status = "failed";
        base.log = logs.join("\n");
        return base;
      }
    }

    base.status = "passed";
    base.log = logs.join("\n");
    return base;
  } catch (error: any) {
    base.status = "error";
    base.log = logs.join("\n") + `\n${error?.message || error}`;
    return base;
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** CLI helper: verify gh available */
export async function assertCiPrerequisites(): Promise<void> {
  await execFileAsync("gh", ["--version"], { timeout: 5000 });
}
