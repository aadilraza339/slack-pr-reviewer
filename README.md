# 🤖 Slack AI PR Reviewer (Human-in-the-Loop)

An automated PR review bot that listens to Slack mentions/messages, analyzes GitHub Pull Requests using **Google Gemini 3.8 Flash**, drafts structured inline comments, and sends them to **you** in Slack for one-click approval before publishing directly to GitHub **under your personal account**.

---

## 🌟 How It Works

1. **Trigger**: A colleague tags the bot or posts a PR URL in Slack (e.g., `@ReviewBot please review https://github.com/org/repo/pull/42`).
2. **AI Diff Analysis**: The bot fetches changed files (paginated), **import-related source context**, runs **separate reviews per repo** for paired Web+API PRs, then a **cross-repo compatibility** pass. Gemini returns **blocking** vs **suggestion** inline comments:
   - A high-level architectural & quality summary.
   - Specific inline code comments (with file paths and line numbers).
   - An overall suggested verdict (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`).
3. **Approval Card**: The bot sends **YOU** a private DM in Slack displaying the full review draft with interactive buttons:
   - **`[✅ Approve & Post to GitHub]`**
   - **`[💬 Post Comments Only]`**
   - **`[❌ Discard]`**
4. **Publish Under Your Name**: When you click approve, the bot calls the GitHub REST API using **your GitHub identity** (GitHub CLI login or a personal access token). The review and all inline comments appear on GitHub authored by **you**.
5. **Thread Notification**: The bot posts back to the original Slack thread with a direct link to the published review.

---

## 🚀 Setup Guide (5 Minutes)

### Step 1: Clone & Install Dependencies

```bash
cd slack-pr-reviewer
npm install
cp .env.example .env
```

---

### Step 2: Get a Free Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/).
2. Click **"Get API key"** -> **"Create API key"** (100% Free).
3. Paste it in `.env` as `GEMINI_API_KEY`.

---

### Step 3: GitHub authentication (recommended: GitHub CLI)

Reviews are posted under **your** GitHub user. You do not need a PAT in `.env` if you use the CLI.

**Option A — GitHub CLI (recommended, ~50 MB install)**

```bash
brew install gh   # macOS; see https://cli.github.com/ for other platforms
gh auth login     # choose GitHub.com, HTTPS, login via browser; grant repo access
gh auth status    # should show "Logged in to github.com"
```

The bot reads your session via `gh auth token` at startup. No `ghp_...` string in `.env`, and tokens stay in the OS keychain.

**Option B — Personal access token (CI / servers without `gh`)**

1. [Generate a classic PAT](https://github.com/settings/tokens) with **`repo`** scope.
2. Set `GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...` in `.env`.

Env token wins if both are set.

When **`gh`** is installed, approved reviews are posted with `gh api repos/.../pulls/.../reviews --input` and a JSON body (`event`, `body`, `comments[]`)—same approach as scripting reviews by hand. Comment text is normalized before send; if inline lines fail validation, the bot falls back to a summary-only review with comments in the body.

### Deep context + optional CI (hosted)

Reviews load **sibling modules** (same folder as each changed `.ts`/`.tsx` file) plus imports—not just the PR diff. Optional explicit companions: `companion-rules.example.json` + `PR_REVIEW_COMPANION_RULES_PATH`.

| Command | Purpose |
|---------|---------|
| `npm run pr:context -- <pr-url>` | List related context files fetched for a PR |
| `npm run pr:ci -- <pr-url>` | Clone PR head and run build/test/lint |
| `npm run pr:check -- <url> [url2]` | Context + CI for paired PRs |

Set `PR_REVIEW_RUN_CI=true` in `.env` on your **live** host so Slack-triggered reviews also run CI (adds several minutes; requires `git` + `gh` on the machine).

---

### Step 4: Create & Configure the Slack App

1. Go to [Slack API: Your Apps](https://api.slack.com/apps) and click **"Create New App"** > **"From scratch"**.
2. Name it (e.g. `PR Reviewer`) and pick your Slack workspace.

#### Enable Socket Mode (No Public URL / ngrok needed!)
3. In the left sidebar, click **"Socket Mode"** and toggle it **Enable**.
4. Generate an App-Level Token (name it `socket-token` with scope `connections:write`).
5. Copy the token (`xapp-...`) and paste it in `.env` as `SLACK_APP_TOKEN`.

#### Add Bot Permissions (OAuth & Permissions)
6. Go to **"OAuth & Permissions"** in the left sidebar.
7. Under **Scopes > Bot Token Scopes**, add:
   - `app_mentions:read` (listen when tagged)
   - `channels:history` (read PR URLs in public channels)
   - `groups:history` (read PR URLs in private channels)
   - `chat:write` (send messages and thread replies)
   - `im:history` (listen to DMs)
   - `im:write` (send approval DMs to you)
8. Scroll to the top of the page and click **"Install to Workspace"**.
9. Copy the **Bot User OAuth Token** (`xoxb-...`) and paste it in `.env` as `SLACK_BOT_TOKEN`.

#### Enable Event Subscriptions
10. In the left sidebar, go to **"Event Subscriptions"** and toggle **Enable Events** ON.
11. Under **"Subscribe to bot events"**, add:
    - `app_mention`
    - `message.channels`
    - `message.groups`
12. Click **"Save Changes"**.

#### Get Signing Secret
13. In the left sidebar, click **"Basic Information"**.
14. Scroll to **"App Credentials"**, copy the **Signing Secret**, and paste it in `.env` as `SLACK_SIGNING_SECRET`.

---

### Step 5: Find Your Personal Slack User ID
1. Open Slack on desktop or web.
2. Click on your profile picture in the bottom-left or top-right corner.
3. Click the three dots icon (`...`) > **"Copy member ID"**.
4. Paste it in `.env` as `SLACK_REVIEWER_USER_ID` (e.g. `U0123456789`).

---

## 🏃 Running the Bot

Start the bot in development mode with live reload:

```bash
npm run dev
```

You will see:
```text
⚡️ Slack PR Review Bot is running in Socket Mode!
```

---

## 🧪 Testing the Workflow

1. Invite the bot to any channel in Slack: `/invite @PR Reviewer`.
2. Post a message or tag the bot with a pull request URL:
   > `@PR Reviewer please review https://github.com/my-org/my-repo/pull/1`
3. The bot will reply in the thread acknowledging the request.
4. Check your Slack Direct Messages: You will receive an interactive card with:
   - PR overview
   - AI-generated summary
   - List of line-by-line comments
5. Click **"Approve & Post to GitHub"**.
6. Check the PR on GitHub — the review is published **by your GitHub account**!
