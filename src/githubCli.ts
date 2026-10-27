import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitHubToken } from "./githubAuth.js";

const execFileAsync = promisify(execFile);

let ghInstalled: boolean | null = null;

export async function isGhCliInstalled(): Promise<boolean> {
  if (ghInstalled !== null) return ghInstalled;
  try {
    await execFileAsync("gh", ["--version"], { timeout: 5_000 });
    ghInstalled = true;
  } catch {
    ghInstalled = false;
  }
  return ghInstalled;
}

/**
 * POST JSON to the GitHub REST API via `gh api --input -` (same pattern as manual PR review scripts).
 */
export async function ghApiPost<TResponse = Record<string, unknown>>(
  endpoint: string,
  body: unknown
): Promise<TResponse> {
  const { token } = await resolveGitHubToken();
  const jsonBody = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "gh",
      ["api", endpoint, "--method", "POST", "--input", "-"],
      {
        env: {
          ...process.env,
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
        },
      }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `gh api exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}") as TResponse);
      } catch {
        reject(new Error(`gh api returned non-JSON: ${stdout.slice(0, 200)}`));
      }
    });

    proc.stdin.write(jsonBody);
    proc.stdin.end();
  });
}
