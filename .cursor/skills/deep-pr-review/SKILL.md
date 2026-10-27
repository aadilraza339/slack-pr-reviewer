---
name: deep-pr-review
description: Run slack-pr-reviewer with maximum catch rate for paired Web+API PRs. Use when testing review quality or tuning context/CI for any feature area.
---

# Deep PR review (slack-pr-reviewer)

## Trigger format in Slack

Post both links with labels (case-insensitive):

```text
WEB: https://github.com/wysbryxtech/peoplefirst-web/pull/NNNN
API: https://github.com/wysbryxtech/peoplefirst-api/pull/NNNN
```

Tag the bot in the same thread.

## What the bot does (v2 pipeline)

1. **Fetch** — paginated PR files + **siblings in each changed file’s directory** + imports (up to 22 context files). Optional JSON companions via `PR_REVIEW_COMPANION_RULES_PATH`.
2. **Split review** — one Gemini pass per repo (web rules vs API rules).
3. **Cross-repo pass** — Web ⟷ API contracts, audit/history display semantics.
4. **Tiers** — `blocking` vs `suggestion` inline comments (Viswesh-style).
5. **Human gate** — DM draft in Slack; you approve before `gh api` posts to GitHub.

## Auth

- Local: `gh auth login` (no PAT in `.env` required).
- CI: `GITHUB_PERSONAL_ACCESS_TOKEN` with `repo` scope.

## Quality checklist (human after bot draft)

Compare draft to staff review themes for this feature:

- [ ] Cross-file behavior (what is stored vs what UI/history displays)
- [ ] Null / optional IDs and org-wide defaults (API)
- [ ] Style consistency with sibling files in the same directory (API/Web)
- [ ] A11y (labels, tooltips) and cross-module imports (Web)
- [ ] Web ⟷ API field names, types, and required params

If the bot missed an item, check logs for `[GitHub] … related context file(s)` — zero context may mean imports weren’t resolved.

## Optional env

- `GEMINI_MODEL` — stronger model for harder PRs (slower/costlier).
- `PR_REVIEW_RUN_CI=true` — on hosted bot: clone PR head, `npm ci`, build/test/lint (needs `git` + `gh` on server).

## CLI (hosted / debug)

```bash
npm run pr:context -- https://github.com/wysbryxtech/peoplefirst-api/pull/2982
PR_REVIEW_RUN_CI=true npm run pr:check -- \
  https://github.com/wysbryxtech/peoplefirst-web/pull/3216 \
  https://github.com/wysbryxtech/peoplefirst-api/pull/2982
```

If cross-folder companions are needed, add `companion-rules.json` (see `companion-rules.example.json`) — do not hardcode domains in code.

## Run locally

```bash
npm run dev
```

Watch console for `[Review] Split paired review` and `[Review] Cross-repo compatibility pass`.
