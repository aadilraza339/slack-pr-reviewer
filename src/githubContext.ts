import { getOctokit } from "./githubAuth.js";
import {
  getOptionalCompanionPathsForRepo,
  getSiblingDirectoriesFromChangedFiles,
} from "./companionFiles.js";

const MAX_TOTAL_CONTEXT = 22;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_SIBLINGS_PER_DIR = 8;

/**
 * Pull request file list with pagination (GitHub default cap is 300; we paginate at 100).
 */
export async function listAllPullRequestFiles(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<
  Array<{
    filename: string;
    patch?: string;
    additions: number;
    deletions: number;
  }>
> {
  const octokit = await getOctokit();
  const all: Array<{
    filename: string;
    patch?: string;
    additions: number;
    deletions: number;
  }> = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    if (data.length === 0) break;
    for (const f of data) {
      if (f.filename.endsWith(".lock") || f.filename.endsWith("-lock.json")) continue;
      all.push({
        filename: f.filename,
        patch: f.patch,
        additions: f.additions,
        deletions: f.deletions,
      });
    }
    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

function extractImportPathsFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const paths = new Set<string>();
  const patterns = [
    /from\s+['"](@\/[^'"]+)['"]/g,
    /from\s+['"](\.[^'"]+)['"]/g,
    /import\s*\(\s*['"](@\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(patch)) !== null) {
      paths.add(m[1]);
    }
  }
  return [...paths];
}

function resolveImportPathCandidates(importPath: string, fromFile: string): string[] {
  if (importPath.startsWith("@/")) {
    const sub = importPath.slice(2);
    return [`src/${sub}.ts`, `src/${sub}.tsx`, `src/${sub}/index.ts`, `src/${sub}/index.tsx`];
  }
  if (importPath.startsWith(".")) {
    const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    const parts = [...fromDir.split("/"), ...importPath.split("/")];
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") resolved.pop();
      else resolved.push(p);
    }
    const base = resolved.join("/");
    if (base.endsWith(".ts") || base.endsWith(".tsx")) return [base];
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  }
  return [];
}

async function fetchFileAtPath(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  ref: string,
  paths: string[]
): Promise<{ filename: string; content: string } | null> {
  for (const path of paths) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data) || !data.content) continue;
      const decoded = Buffer.from(data.content, "base64").toString("utf8");
      return { filename: path, content: decoded };
    } catch {
      continue;
    }
  }
  return null;
}

async function listSiblingSourcePaths(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  ref: string,
  directory: string,
  changedSet: Set<string>
): Promise<Array<{ path: string; reason: string }>> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: directory,
      ref,
    });
    if (!Array.isArray(data)) return [];

    const files = data
      .filter((e) => e.type === "file" && /\.(tsx?|jsx?)$/.test(e.name))
      .map((e) => `${directory}/${e.name}`)
      .filter((p) => !changedSet.has(p))
      .sort()
      .slice(0, MAX_SIBLINGS_PER_DIR);

    return files.map((path) => ({
      path,
      reason: `sibling module in \`${directory}/\``,
    }));
  } catch {
    return [];
  }
}

export interface RelatedSourceContext {
  filename: string;
  reason: string;
  content: string;
}

type CandidateMap = Map<string, string>;

function addCandidates(
  map: CandidateMap,
  entries: Map<string, string> | Iterable<[string, string]> | Array<{ path: string; reason: string }>
) {
  if (entries instanceof Map) {
    for (const [path, reason] of entries) {
      if (!map.has(path)) map.set(path, reason);
    }
    return;
  }
  for (const entry of entries) {
    const path = Array.isArray(entry) ? entry[0] : entry.path;
    const reason = Array.isArray(entry) ? entry[1] : entry.reason;
    if (!map.has(path)) map.set(path, reason);
  }
}

/**
 * Fetches related source: known companions, directory siblings, then import graph.
 */
export async function fetchRelatedSourceContext(
  owner: string,
  repo: string,
  ref: string,
  changedFiles: Array<{ filename: string; patch?: string }>
): Promise<RelatedSourceContext[]> {
  const octokit = await getOctokit();
  const changedSet = new Set(changedFiles.map((f) => f.filename));
  const changedNames = changedFiles.map((f) => f.filename);
  const candidates: CandidateMap = new Map();

  // 1) Optional explicit companions (JSON file — off by default)
  addCandidates(candidates, getOptionalCompanionPathsForRepo(repo, changedNames));

  // 2) Sibling files in each changed file's parent directory (any feature area)
  for (const dir of getSiblingDirectoriesFromChangedFiles(changedNames)) {
    const siblings = await listSiblingSourcePaths(octokit, owner, repo, ref, dir, changedSet);
    addCandidates(
      candidates,
      siblings.map((s) => [s.path, s.reason] as [string, string])
    );
  }

  // 3) Import graph from patches
  for (const file of changedFiles) {
    if (!/\.(tsx?|jsx?)$/.test(file.filename)) continue;
    for (const imp of extractImportPathsFromPatch(file.patch)) {
      for (const resolved of resolveImportPathCandidates(imp, file.filename)) {
        if (!changedSet.has(resolved)) {
          candidates.set(resolved, `imported from \`${file.filename}\``);
        }
      }
    }
  }

  const results: RelatedSourceContext[] = [];
  const seen = new Set<string>();

  for (const [filename, reason] of candidates) {
    if (results.length >= MAX_TOTAL_CONTEXT) break;
    if (seen.has(filename)) continue;

    const base = filename.replace(/\.(tsx?|jsx?)$/, "");
    const fetched = await fetchFileAtPath(octokit, owner, repo, ref, [
      filename,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]);
    if (!fetched || seen.has(fetched.filename)) continue;
    seen.add(fetched.filename);
    results.push({
      filename: fetched.filename,
      reason,
      content:
        fetched.content.length > MAX_CONTEXT_CHARS
          ? fetched.content.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]"
          : fetched.content,
    });
  }

  return results;
}
