# PeopleFirst Web — Frontend PR Review Rules

Use this document when reviewing **`peoplefirst-web`** pull requests (human reviewers, Slack PR bots, or AI review prompts). It summarizes team UI governance owned by the UI layer (Bhuvan) and points to the canonical rule set in the repo.

**Repository:** `wysbryxtech/peoplefirst-web` (paths below are relative to that repo root).

---

## Authority and source of truth

| Priority | Document | Role |
|----------|----------|------|
| **1 (wins on conflict)** | `src/features/dev-docs/components/previews/guidelines-data.ts` (`STE_GUIDELINES`) | Every `MUST`, `DO NOT`, `SHOULD`, and `A11Y` rule for layout, buttons, forms, tables, tokens, feedback |
| **2** | In-app dev-docs → Guidelines (`GuidelinesPreview.tsx`) | Same data as human-readable UI |
| **3** | `src/features/dev-docs/components/previews/GovernancePreview.tsx` | Rule #1 + 4-tier component architecture + when to extract to `common/` |
| **4** | `.github/REVIEW_CHECKLIST.md`, `.github/copilot-instructions.md` | Security, stack, fast-breakers |
| **5** | `docs/design/DESIGN-SYSTEM.md`, `docs/design/GLASS-UI-PHILOSPHY.md` | Theme and elevation; defer to `STE_GUIDELINES` if they disagree |

**Reviewer workflow:** For each PR, identify touched UI areas (header, form, table, dialog, etc.), open `guidelines-data.ts`, and read all `STE_GUIDELINES` entries whose `category` matches (see table below). Flag any violated `MUST` or `DO NOT` with `file:line` and the guideline `id` (e.g. `buttons-pill-geometry`).

### Category map (`STE_GUIDELINES[].category`)

| PR touches… | Read categories |
|-------------|-----------------|
| Headers, tabs, breadcrumbs, action placement | `positions`, `navigation` |
| Page layout, cards, grids, responsive | `layout` |
| Buttons, icon buttons, add/remove rows | `buttons` |
| Padding, gaps, section rhythm | `spacing` |
| Headings, labels, money, truncation | `typography` |
| Data tables, PII, bulk actions | `tables` |
| Forms, filters, validation, dates | `forms` |
| Loading, errors, modals, toasts, permissions | `feedback` |
| Colors, badges, +N overflow counts | `tokens` |

---

## Architecture Rule #1 (non-negotiable)

**Never modify `src/components/ui/*`.** These are pristine ShadCN primitives.

| Need | Where to change |
|------|-----------------|
| Global theme (colors, shadows, radii) | `src/index.css` |
| Design-system wrappers (tabs, pills, brand patterns) | `src/components/custom/` |
| Shared layout blocks (3+ modules, no domain API) | `src/components/common/` |
| One-off styling | `className` at call site |
| Feature UI | `src/components/[domain]/` or `src/features/` |

### 4-tier component architecture

1. `src/components/ui/` — Immutable ShadCN (update via `npx shadcn@latest add --overwrite` only).
2. `src/components/custom/` — Design-system primitives.
3. `src/components/common/` — Cross-module blocks (`PageShell`, `FormGrid`, `DataTableControls`, etc.).
4. `src/components/[domain]/` & `src/features/` — Domain workflows.

**Extract to `common/` only when all are true** (see `GovernancePreview.tsx`):

- Pattern used in **3+ distinct modules**
- **No** domain-specific state or API imports
- Generic props (`value`, `onChange`, …)

Do **not** extract for 1–2 pages or feature-store coupling.

---

## P0 — Security and auth (review first)

- Protected routes must enforce session/auth before rendering sensitive data.
- Buttons, routes, and mutations respect RBAC / permissions (server is authoritative; UI is guidance only).
- TanStack Query keys and API params include **tenant** context where applicable.
- No `.env` or secrets in code or PR discussion.

---

## Stack and code quality (fast-breakers)

Request changes if the PR introduces any of the following:

| Trigger | Rule |
|---------|------|
| Edits under `src/components/ui/` | Use wrappers, `index.css`, or call-site classes |
| `fetch()` in `useEffect` for server data | Use **TanStack Query** |
| `window.location` for in-app navigation | Use **TanStack Router** |
| New `@ts-nocheck`, `@ts-ignore`, or careless `any` | Fix types |
| Full-page spinner that unmounts page chrome on load | Use skeleton inline (`feedback-screen-states`); keep header/tabs/toolbar |
| `window.confirm` for unsaved navigation | Use dialog pattern (`feedback-unsaved-changes-guard`) |
| Raw hex / `text-slate-*` in JSX for product UI | Use semantic tokens (`bg-card`, `text-foreground`, `border-border`, …) |

Also see `.github/REVIEW_CHECKLIST.md` for PR-type expectations (screenshots on features, etc.).

---

## High-impact STE rules (cheat sheet)

Use `guidelines-data.ts` for full `doList` / `dontList`. These are the rules most often broken in review:

### Positions and actions (`positions`, `navigation`)

- Content and titles **left**; primary actions **right**.
- In-page form actions (left → right): **Cancel (outline)** → **Delete (outline, destructive text)** → **Save (default)**.
- Confirm dialogs: destructive confirm may be rightmost.
- Tab-scoped actions sit on the **same row** as the tab tier they apply to—not in the table toolbar below.
- Level 1 tabs: solid brand primary fill; Level 2: underline active state (see `nav-brand-tabs`).

### Buttons (`buttons`)

- All action buttons: **`rounded-full`** (pill); no `rounded-md` / square primary actions.
- **One** primary (`variant="default"`) per section.
- **No decorative icons** on business labels (e.g. “Add Employee”); icons only for universal verbs: **Edit, Delete, Search, Download, Close** on labeled buttons.
- No solid `bg-destructive` buttons on-page for delete—outline + `text-destructive` + confirmation dialog.

### Layout (`layout`)

- `PageShell`: **`p-0`** for table/list views, **`p-6`** for forms/detail; avoid `min-h-[60vh]` hacks on shells.
- No card inside card (`layout-card-nesting`).
- Prefer 3-tier elevation (`bg-background` / `bg-card` / `bg-muted`); avoid heavy `shadow-2xl` for separation.

### Forms (`forms`)

- Responsive **4-column** grid (`FormGrid` / `grid-cols-1 md:grid-cols-4`) unless settings panel constraints require 3; use `GridField span` for width.
- Label → input: `space-y-1.5`; errors: `text-xs text-destructive` under field with `aria-describedby`.
- Read-only detail: **LabelValue**, not disabled inputs.

### Tables (`tables`)

- Neutral header row (not `bg-primary` on thead).
- Text left; **numbers and currency right** with `tabular-nums`.
- Overflow counts: **CountBadge** / **FirstPlusCount**, not raw `"+2"` strings.
- Long text: **truncate** + accessible tooltip; `table-fixed` + `min-w-0` when needed to avoid panel horizontal scroll.

### Feedback (`feedback`)

- Loading: preserve chrome; **InlineTableSkeleton** (or equivalent), not `if (loading) return <Spinner />`.
- Unsaved leave: dialog with **Discard** / **Keep editing**; intercept backdrop/Escape when dirty.
- Permission denied: hide nav or disable with **tooltip** explaining why—not clickable 403 toasts.

### Tokens (`tokens`)

- Status: color tint + icon + text (not color alone).
- +N badges: `CountBadge`, `rounded-md`, semantic secondary tokens.

### Typography (`typography`)

- **Inter** + standard scale; field labels in **Title Case** (e.g. “Employee Type”) unless product copy dictates otherwise.
- Currency: symbol + locale formatting; null → em dash (—).

---

## Preferred shared components

Before approving new one-off patterns, check for existing primitives:

- Layout: `PageShell`, `FormGrid`, `GridField`, `FormActions`, `DataTableControls`, `FiltersCard`
- Tables: `SettingsTableCard`, `CountBadge`, `FirstPlusCount`, `StatusPill`
- Feedback: `UnsavedChangesDialog` (`src/components/common/SaveDialog.tsx`), `ListErrorRow`, `InlineTableSkeleton`
- Settings recruitment offer letters: `LetterEditorChrome`, `OfferTemplateMetadataFields`, `RecruitmentOfferTemplatesManagement`

---

## Changelog

| Date | Note |
|------|------|
| 2026-10-27 | Initial version: STE authority, architecture, fast-breakers, STE cheat sheet |
