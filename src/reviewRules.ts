/**
 * Repository Review Rules and Guidelines
 *
 * Human-readable copy: docs/peoplefirst-web-ui-pr-review-rules.md
 *
 * Frontend rules align with peoplefirst-web:
 * - STE_GUIDELINES (guidelines-data.ts) — authority on conflict
 * - GovernancePreview.tsx (4-tier architecture)
 * - .github/REVIEW_CHECKLIST.md
 * - Legacy slot/stack notes from .interface-design/system.md (kept where STE does not override)
 *
 * Backend rules from peoplefirst-api/.github/REVIEW_CHECKLIST.md
 */

export const CORE_REVIEW_PRINCIPLES = `
### Core Review Principles & Tone (From .cursor/rules/pr-review.mdc)
1. **STRICT ZERO-FLUFF & ZERO-PRAISE MANDATE (Anti-Sycophancy)**:
   - Absolutely NEVER write compliments, platitudes, or praise comments.
   - DO NOT write comments like: "Great addition of...", "The structure looks exceptionally clean", "Tenant isolation is correctly maintained", or "Nicely done".
   - Inline comments are STRICTLY reserved for DEFECTS, performance bottlenecks, unhandled edge cases, missing validations, or breaking changes.
   - If a file or function has no defects, DO NOT invent advice to fill the comments array. The comments array MUST BE EMPTY: \`[]\`. An approval with 0 comments is 100x better than fake praise.

2. **No Vague or Boilerplate Advice**:
   - Never say "ensure error handling follows design system tokens" unless pointing to a specific invalid token (e.g. \`text-gray-500\`) and providing the exact replacement (\`text-muted-foreground\`).
   - If you flag an issue, you MUST provide a concrete code snippet fix.
   - For peoplefirst-web UI violations, cite the STE guideline \`id\` when known (e.g. \`buttons-pill-geometry\`, \`layout-card-nesting\`).

3. **High Bar for Findings**:
   - Only flag findings that would change a merge decision (actual bugs, security holes, contract breaks, performance flaws, race conditions, unhandled edge cases, or violated MUST/DO NOT STE rules).
   - Skip trivial nitpicks, subjective formatting, or cosmetic preferences unless they hide a defect.
`;

export const CROSS_REPO_BREAKING_RULES = `
### Cross-Repository Breaking Change Rules (Web <-> API Synchronization)
When reviewing paired PRs (Web + API), rigorously check whether a change in one repository breaks the other:
1. **Endpoint Routes & Methods**:
   - Verify that any endpoint path, URL parameters, or HTTP method modified in the API are updated identically in the Web API client.
   - Check that route prefixes (e.g. \`/api/v1/...\`) match.
2. **Request Payloads & Required Fields**:
   - Check if the API introduces new required body properties (e.g. \`required = true\` on a resolver or Zod required field) that the Web frontend does not supply, or supplies under a different property name.
   - Watch for camelCase vs snake_case mismatches between frontend JSON and backend schemas.
3. **Response DTO Shapes & Field Renames**:
   - Verify that response structures returned by the API match the TypeScript interfaces and destructuring in the Web frontend.
   - Watch for restructured envelopes (e.g. \`{ data: [...] }\` vs \`{ data: { items: [...] } }\` or nullability differences).
4. **Enums & Status Constants**:
   - Ensure enum values, action strings, and status codes are synchronized across both codebases.
5. **Deployment & Migration Sequencing**:
   - Flag any dependency where the backend database or service must be deployed and migrated before the frontend can safely run without 500 errors.
   - Check for backward compatibility: will current production Web crash if API is deployed first?
`;

export const FRONTEND_UI_RULES = `
### PeopleFirst Web — Frontend PR Rules (peoplefirst-web)
Apply when reviewing frontend / peoplefirst-web PRs. On conflict, STE_GUIDELINES in \`src/features/dev-docs/components/previews/guidelines-data.ts\` wins.

#### STE reviewer workflow
Identify touched UI areas from the diff, then mentally apply every STE \`MUST\` / \`DO NOT\` for matching categories:
- Headers, tabs, breadcrumbs, actions → \`positions\`, \`navigation\`
- Page layout, cards, grids → \`layout\`
- Buttons → \`buttons\`
- Padding, gaps → \`spacing\`
- Headings, labels, money → \`typography\`
- Tables → \`tables\`
- Forms, filters, validation → \`forms\`
- Loading, errors, modals, toasts → \`feedback\`
- Colors, badges → \`tokens\`

#### Architecture Rule #1 (non-negotiable)
- **Never modify \`src/components/ui/*\`** (ShadCN primitives). Request changes on any PR that edits these files.
- Global theme → \`src/index.css\`; design-system wrappers → \`src/components/custom/\`; shared blocks (3+ modules, no domain API) → \`src/components/common/\`; feature UI → \`src/components/[domain]/\` or \`src/features/\`.
- Extract to \`common/\` only when: used in 3+ modules, no domain API/state, generic props. Do not extract for 1–2 pages.

#### P0 — Security and auth (review first on Web PRs)
- Protected routes must enforce session/auth before sensitive data renders.
- Buttons, routes, mutations respect RBAC (server authoritative; UI is guidance).
- TanStack Query keys and API params include **tenant** context where applicable.
- No secrets in code or review text.

#### Stack fast-breakers (request changes)
| Trigger | Rule |
| Edits under \`src/components/ui/\` | Wrappers, \`index.css\`, or call-site \`className\` |
| \`fetch()\` in \`useEffect\` for server data | TanStack Query |
| \`window.location\` for in-app nav | TanStack Router |
| \`@ts-nocheck\`, \`@ts-ignore\`, careless \`any\` | Fix types |
| Full-page spinner unmounting chrome | Inline skeleton; keep header/tabs/toolbar (\`feedback-screen-states\`) |
| \`window.confirm\` for unsaved leave | \`UnsavedChangesDialog\` pattern (\`feedback-unsaved-changes-guard\`) |
| Raw hex / \`text-slate-*\` in product UI | Semantic tokens (\`bg-card\`, \`text-foreground\`, \`border-border\`, …) |

#### High-impact STE rules (most often broken)
**Positions & navigation:** Content/titles left; primary actions right. Form footer (L→R): Cancel (outline) → Delete (outline, destructive text) → Save (default). Tab-scoped actions on the **same row** as their tab tier—not table toolbar. L1 tabs: solid brand primary; L2: underline active (\`nav-brand-tabs\`).

**Buttons:** Action buttons \`rounded-full\` (pill)—no \`rounded-md\` primary actions. One \`variant="default"\` primary per section. No decorative icons on business labels; icons only on Edit, Delete, Search, Download, Close. On-page delete: outline + \`text-destructive\` + confirm dialog—not solid \`bg-destructive\`.

**Layout:** \`PageShell\`: \`p-0\` list/table, \`p-6\` forms/detail; no \`min-h-[60vh]\` shell hacks. No card-in-card (\`layout-card-nesting\`). 3-tier elevation (\`bg-background\` / \`bg-card\` / \`bg-muted\`); avoid heavy \`shadow-2xl\`.

**Forms:** 4-column \`FormGrid\` (\`grid-cols-1 md:grid-cols-4\`) unless settings panel needs 3; \`GridField span\` for width. Label→input \`space-y-1.5\`; errors \`text-xs text-destructive\` + \`aria-describedby\`. Read-only detail: **LabelValue**, not disabled inputs.

**Tables:** Neutral thead (not \`bg-primary\`). Text left; numbers/currency right + \`tabular-nums\`. Overflow: **CountBadge** / **FirstPlusCount**, not \`"+2"\`. Long cells: truncate + tooltip; \`table-fixed\` + \`min-w-0\` to prevent horizontal scroll in settings panels.

**Feedback:** Loading preserves chrome (**InlineTableSkeleton**). Permission denied: hide/disable + tooltip—not 403 toast on click.

**Tokens & typography:** Status = tint + icon + text. Inter scale; labels Title Case. Currency formatted; null → em dash (—).

#### Content stack (legacy slot order — still enforce if diff touches page chrome)
Slots: Page Bar (2) → L1 \`TabsOrange\` (3) → L2 \`SubTabs\` (4) → \`DataTableControls\` toolbar (5) → body (6).
- List views: primary actions at Sub-tabs row (slot 4, right)—not Page Bar.
- Create/edit/detail: Cancel + Save in Page Bar (slot 2, right)—not form footer/card header unless STE form-actions rule applies to that surface.
- Toolbars: \`DataTableControls\`—no ad-hoc search/filter rows.
- One surface: no nested \`Card\`; forms/tables on stage; section grouping via \`border-t border-border/50\`, not inner cards.

#### Prefer existing shared components over one-offs
\`PageShell\`, \`FormGrid\`, \`GridField\`, \`FormActions\`, \`DataTableControls\`, \`FiltersCard\`, \`SettingsTableCard\`, \`CountBadge\`, \`FirstPlusCount\`, \`StatusPill\`, \`UnsavedChangesDialog\` (\`SaveDialog.tsx\`), \`ListErrorRow\`, \`InlineTableSkeleton\`.
`;

/** Mandatory audit block injected into the Gemini prompt for Web PRs only. */
export const FRONTEND_MANDATORY_AUDIT = `
4. **Frontend Architecture & STE Audit (peoplefirst-web)**:
   - If ANY file under \`src/components/ui/\` changed, mark \`uiDesignTokensStatus: "FAILED"\` and request changes.
   - Scan for fast-breakers: \`fetch\` in \`useEffect\`, \`window.location\`, \`window.confirm\`, full-page loaders, raw \`text-slate-*\`/hex colors.
   - For UI diffs, flag violated STE MUST/DO NOT rules with \`file:line\`, guideline \`id\`, and a concrete fix snippet.
   - Flag horizontal overflow risks (long table cells without truncate/\`min-w-0\`), wrong button order/icons, missing tenant in query keys where siblings include it.
`;

export const BACKEND_API_RULES = `
### Backend API Architecture & Security Rules (From peoplefirst-api/.github/REVIEW_CHECKLIST.md)
1. **P0 Database Performance & N+1 Query Traps (STRICT CHECK)**:
   - CRITICAL: Never execute database queries (\`await tx.update\`, \`await tx.select\`, \`await tx.insert\`, \`await db...\`) inside a loop (\`for\`, \`for...of\`, \`for...in\`, \`.map()\`, \`forEach()\`).
   - If updating multiple rows based on IDs, collect IDs and execute a single batch update using \`inArray()\` or a single SQL query!
   - Push filtering and pagination to the database: Never fetch thousands of rows into memory to filter with JS \`.filter()\` or \`.slice()\`.
   - Avoid over-fetching: Select only the required columns instead of full \`select()\` across multiple large tables.

2. **P0 Tenant Isolation & Authorization**:
   - Every database query and mutation MUST be strictly scoped to the authenticated tenant (\`eq(table.tenant, tenant)\`) to prevent IDOR / cross-tenant leaks.
   - Role permissions (RBAC) must be validated on the server before executing mutations or returning sensitive records.
   - Never log or return sensitive credentials, tokens, or unhashed passwords.

3. **Fastify Plugins & Clean Code**:
   - Shared cross-cutting concerns (auth guards, rate limiters, context decorators) must be encapsulated in Fastify plugins or shared middleware.
   - Keep controllers and handlers concise (<= 50-100 lines); split complex logic into focused service functions.
   - Use early returns / guard clauses to avoid deep nesting (limit to max 3 levels).
   - Strict TypeScript: No \`any\`, no \`@ts-nocheck\`.
`;

export function isFrontendRepo(repoName: string): boolean {
  return /web|front|peoplefirst-web/i.test(repoName);
}

export function isBackendRepo(repoName: string): boolean {
  return /api|back|srv|peoplefirst-api/i.test(repoName);
}
