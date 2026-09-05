---
description: Show fiefdom status, fief ownership and routing rules
allowed-tools: Bash(fiefdom status:*), Bash(fiefdom memory show:*)
---

Run `fiefdom status` and report:

- each fief, the paths it owns, and how many learnings it has accumulated
- any repository directories no fief owns
- the agent to use for each (`vassal-<id>`, or `baron-<id>` for a barony)
  and a one-line reminder
  that routing happens through the Agent tool / SendMessage, not by editing
  files yourself

Keep it short — a table plus one line of guidance.
