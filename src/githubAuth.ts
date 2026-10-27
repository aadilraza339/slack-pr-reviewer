import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";

const execFileAsync = promisify(execFile);

let octokitInstance: Octokit | null = null;
let resolvedSource: "env" | "gh-cli" | null = null;

/**
 * Resolves a GitHub API token:
 * 1. GITHUB_PERSONAL_ACCESS_TOKEN (for CI / headless deploys)
 * 2. `gh auth token` from GitHub CLI (local dev — no PAT in .env)
 */
export async function resolveGitHubToken(): Promise<{ token: string; source: "env" | "gh-cli" }> {
  const fromEnv = process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: "env" };
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 10_000,
      env: process.env,
    });
    const token = stdout.trim();
    if (token) {
      return { token, source: "gh-cli" };
    }
  } catch {
    // gh missing or not logged in — fall through to error below
  }

  throw new Error(
    "GitHub auth not configured. Either set GITHUB_PERSONAL_ACCESS_TOKEN in .env, or install GitHub CLI and run: gh auth login"
  );
}

export async function getOctokit(): Promise<Octokit> {
  if (octokitInstance) {
    return octokitInstance;
  }
  const { token, source } = await resolveGitHubToken();
  resolvedSource = source;
  octokitInstance = new Octokit({ auth: token });
  return octokitInstance;
}

export function getGitHubAuthSource(): "env" | "gh-cli" | null {
  return resolvedSource;
}

/** Validates GitHub credentials at startup and logs which method is used. */
export async function ensureGitHubAuth(): Promise<void> {
  const octokit = await getOctokit();
  const source = getGitHubAuthSource();
  try {
    const { data } = await octokit.users.getAuthenticated();
    const via =
      source === "env"
        ? "GITHUB_PERSONAL_ACCESS_TOKEN"
        : "GitHub CLI (`gh auth login`)";
    console.log(`[GitHub] Authenticated as @${data.login} via ${via}`);
  } catch (error: any) {
    throw new Error(
      `GitHub token is invalid or lacks API access: ${error?.message || error}. Re-run \`gh auth login\` or regenerate your PAT.`
    );
  }
}
