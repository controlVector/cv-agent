# Dennis — Mac Mini Fix

**Time:** ~5 minutes
**What happened:** The agent was running from your HOME directory (`/Users/dennis`) instead of a project folder. This caused personal files to get committed to the repo. That's fixed now — this guide gets you back to working.

---

## Step 1: Update cv-agent

Open Terminal on the Mac Mini (or SSH in) and run:

```bash
npm install -g @controlvector/cv-agent@1.9.1
```

You should see `+ @controlvector/cv-agent@1.9.1` when it's done.

## Step 2: Stop the old agent

```bash
launchctl unload ~/Library/LaunchAgents/com.cv.agent.plist 2>/dev/null
pkill -f "cva agent" 2>/dev/null
```

This stops the broken agent that was running from your home directory.

## Step 3: Go to your project folder

If you already have Scalper_BOT cloned:

```bash
cd ~/Scalper_BOT
```

If not, create a project folder:

```bash
mkdir -p ~/Projects && cd ~/Projects
```

## Step 4: Run setup

```bash
cva setup
```

This will walk you through everything:
- It'll find your existing CV-Hub login (no need to re-authenticate)
- It'll set up the project (or let you clone one from CV-Hub)
- It'll offer to start the agent

Just follow the prompts — press Enter for the defaults.

## Step 5: Verify it's working

After setup finishes, check that the agent is running:

```bash
cva auth status
```

You should see `Status: valid` and your username.

---

## If something goes wrong

**"Claude Code CLI not found"** — Run this first:
```bash
npm install -g @anthropic-ai/claude-code
```

**"Not authenticated"** — Run:
```bash
cva setup
```
It'll open a browser window for you to log in.

**Agent won't start** — Run it manually:
```bash
cva agent --auto-approve
```
Leave that terminal window open. The agent runs as long as the window is open.

---

## What was the problem?

The agent was set up in `/Users/dennis` (your entire home folder) instead of a specific project directory. When it tried to save code changes, it accidentally included personal files like browser history and credentials. The new version (1.9.1) has a safety check that prevents this from ever happening again — it refuses to run from a home directory.

The leaked files on CV-Hub have been cleaned up (see below).
