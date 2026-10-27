import fs from "node:fs";
import path from "node:path";

/**
 * Generic review context: sibling files in the same folder as each changed source file.
 * Optional JSON rules file for teams that want explicit companion paths (no domain hardcoding in code).
 */

export interface CompanionRule {
  whenPathMatches: string;
  companions: string[];
  label?: string;
}

export interface CompanionRulesFile {
  [repoName: string]: CompanionRule[];
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  "public",
  "assets",
  "__tests__",
  "__mocks__",
]);

/** Minimum path depth for listing siblings (avoids loading all of `src/`). */
const MIN_DIRECTORY_SEGMENTS = 3;

let cachedOptionalRules: CompanionRulesFile | null | undefined;

function parseOptionalRulesFile(filePath: string): CompanionRulesFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as CompanionRulesFile;
}

/**
 * Optional companions from `PR_REVIEW_COMPANION_RULES_PATH` (JSON).
 * Example: `{ "my-api": [{ "whenPathMatches": "src/services/.+", "companions": ["..."] }] }`
 * Regex strings are passed to `new RegExp(whenPathMatches, "i")`.
 */
export function getOptionalCompanionPathsForRepo(
  repoName: string,
  changedFilenames: string[]
): Map<string, string> {
  const out = new Map<string, string>();
  const rulesPath = process.env.PR_REVIEW_COMPANION_RULES_PATH?.trim();
  if (!rulesPath) return out;

  try {
    if (cachedOptionalRules === undefined) {
      const resolved = path.isAbsolute(rulesPath) ? rulesPath : path.join(process.cwd(), rulesPath);
      cachedOptionalRules = fs.existsSync(resolved) ? parseOptionalRulesFile(resolved) : null;
    }
    if (!cachedOptionalRules) return out;

    const rules = cachedOptionalRules[repoName] ?? cachedOptionalRules["*"] ?? [];
    for (const rule of rules) {
      const re = new RegExp(rule.whenPathMatches, "i");
      if (!changedFilenames.some((f) => re.test(f))) continue;
      for (const companion of rule.companions) {
        if (!changedFilenames.includes(companion)) {
          out.set(companion, `optional companion rule: ${rule.label || rule.whenPathMatches}`);
        }
      }
    }
  } catch (error) {
    console.warn("[Review context] Failed to load PR_REVIEW_COMPANION_RULES_PATH:", error);
  }

  return out;
}

function directoryPathOf(file: string): string | null {
  if (!file.includes("/")) return null;
  return file.slice(0, file.lastIndexOf("/"));
}

function isEligibleSiblingDirectory(dir: string): boolean {
  const segments = dir.split("/").filter(Boolean);
  if (segments.length < MIN_DIRECTORY_SEGMENTS) return false;
  if (segments.some((s) => SKIP_DIR_NAMES.has(s))) return false;
  return true;
}

/**
 * For each changed source file, include its parent directory so we can load sibling modules
 * (same pattern for any feature: services/*, components/*, features/*, etc.).
 */
export function getSiblingDirectoriesFromChangedFiles(changedFilenames: string[]): string[] {
  const dirs = new Set<string>();

  for (const file of changedFilenames) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const dir = directoryPathOf(file);
    if (!dir || !isEligibleSiblingDirectory(dir)) continue;
    dirs.add(dir);
  }

  return [...dirs];
}

/** @deprecated use getSiblingDirectoriesFromChangedFiles — kept for tests migrating off repo maps */
export function getSiblingDirectoriesForRepo(_repoName: string, changedFilenames: string[]): string[] {
  return getSiblingDirectoriesFromChangedFiles(changedFilenames);
}

/** @deprecated use getOptionalCompanionPathsForRepo */
export function getCompanionPathsForRepo(repoName: string, changedFilenames: string[]): Map<string, string> {
  return getOptionalCompanionPathsForRepo(repoName, changedFilenames);
}
