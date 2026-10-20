/**
 * Repository Review Rules and Guidelines
 * Extracted directly from:
 * - .cursor/rules/pr-review.mdc
 * - peoplefirst-web/.interface-design/system.md
 * - peoplefirst-web/.github/REVIEW_CHECKLIST.md
 * - peoplefirst-api/.github/REVIEW_CHECKLIST.md
 */

export const CORE_REVIEW_PRINCIPLES = `
### Core Review Principles & Tone (From .cursor/rules/pr-review.mdc)
1. **Human Teammate Tone**:
   - Write in a friendly, constructive, and natural voice as an experienced software engineer on the team.
   - Absolutely NO robotic AI phrases (avoid "as an AI", "the code looks solid", "consider adhering to best practices").
   - Ensure impeccable grammar, natural phrasing, and concise clarity.
2. **High Bar for Findings**:
   - Only flag findings that would change a merge decision (actual bugs, security holes, contract breaks, performance flaws, race conditions, or unhandled edge cases).
   - Skip trivial nitpicks, subjective formatting, or cosmetic preferences unless they hide a defect.
3. **Actionable Suggestions with Code Blocks**:
   - Whenever pointing out an issue, provide a concrete code fix using clean GitHub markdown snippets.
   - Show the exact replacement or guard clause matching the repository's coding style (early returns, immutable state updates, strict types).
`;

export const CROSS_REPO_BREAKING_RULES = `
### Cross-Repository Breaking Change Rules (Web <-> API Synchronization)
When reviewing paired PRs (Web + API), rigorously check whether a change in one repository breaks the other:
1. **Endpoint Routes & Methods**:
   - Verify that any endpoint path, URL parameters, or HTTP method modified in the API are updated identically in the Web API client.
   - Check that route prefixes (e.g. \`/api/v1/...\`) match.
2. **Request Payloads & Required Fields**:
   - Check if the API introduces new required body properties or query parameters that the Web frontend does not supply, or supplies under a different property name.
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
### Frontend UI Principles & Component Rules (From peoplefirst-web/.interface-design/system.md & REVIEW_CHECKLIST.md)
1. **The "One Surface" Rule**:
   - Content sits on white cards inside the stage (\`sidebar-inset\`).
   - NEVER nest a \`Card\` inside another \`Card\`.
   - Forms and tables sit directly on the surface—never wrap a table or form in a \`Card\` container.
   - Visual grouping inside forms must use \`border-t border-border/50\` dividers with section labels, not cards.
2. **The Content Stack & Slot Order**:
   - Slots must strictly follow: Page Bar (Slot 2) -> Level 1 Tabs (\`TabsOrange\`, Slot 3) -> Level 2 Tabs (\`SubTabs\`/\`Level2Tabs\`, Slot 4) -> Toolbar (\`DataTableControls\`, Slot 5) -> Content Body (Slot 6).
   - Never rearrange or render elements outside these slots.
3. **Action Buttons Placement**:
   - On landing pages (list views): Primary action buttons belong at the Sub-tabs level (Slot 4, right-aligned). NOT in the Page Bar.
   - On sub-pages (create/edit/detail): Action buttons (Cancel outline + Save primary) belong in the Page Bar (Slot 2, right-aligned). Never at the bottom of forms or in \`CardHeader\`.
4. **Design Tokens & Typography**:
   - ONLY use design tokens: \`text-foreground\`, \`text-muted-foreground\`, \`text-primary\`, \`text-destructive\`, \`var(--color-tab-active)\`.
   - NEVER use raw Tailwind colors like \`text-gray-500\`, \`text-gray-900\`, \`text-slate-*\`, or arbitrary hex colors.
5. **Component Reusability & Libraries**:
   - Toolbars must always use \`DataTableControls\`. No ad-hoc flex rows for search/filters/pagination.
   - NEVER modify ShadCN primitives directly in \`src/components/ui/\`—wrap them in custom components.
   - Use TanStack Query for all data fetching (NEVER call \`fetch()\` or axios directly inside \`useEffect\`).
   - Use TanStack Router for navigation (NEVER use \`window.location\`).
   - Strict TypeScript: No \`@ts-ignore\`, \`@ts-nocheck\`, or explicit \`any\`.
`;

export const BACKEND_API_RULES = `
### Backend API Architecture & Security Rules (From peoplefirst-api/.github/REVIEW_CHECKLIST.md)
1. **P0 Tenant Isolation & Authorization**:
   - Every database query and mutation MUST be strictly scoped to the authenticated tenant (\`tenant\` filter) to prevent IDOR / cross-tenant leaks.
   - Role permissions (RBAC) must be validated on the server before executing mutations or returning sensitive records.
   - Never log or return sensitive credentials, tokens, or unhashed passwords.
2. **Database Performance & N+1 Query Traps**:
   - NO N+1 query loops: Never execute database queries inside \`.map()\`, \`for...of\`, or \`forEach\`. Use \`inArray()\` or a single batch query/JOIN.
   - Push filtering and pagination to the database: Never fetch thousands of rows into memory to filter with JS \`.filter()\` or \`.slice()\`.
   - Avoid over-fetching: Select only the required columns instead of full \`select()\` across multiple large tables.
3. **Fastify Plugins & Clean Code**:
   - Shared cross-cutting concerns (auth guards, rate limiters, context decorators) must be encapsulated in Fastify plugins or shared middleware.
   - Keep controllers and handlers concise (<= 50-100 lines); split complex logic into focused service functions.
   - Use early returns / guard clauses to avoid deep nesting (limit to max 3 levels).
   - Strict TypeScript: No \`any\`, no \`@ts-nocheck\`.
`;
