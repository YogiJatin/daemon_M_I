# RUNBOOK.md

Operational steps for the Personal AI OS Worker. Every command runs from the
project root (`personal-ai-os`) in PowerShell unless stated otherwise.

## 1. Deploy

```powershell
npx wrangler d1 time-travel info personal-ai-os-db --remote   # record the bookmark first
npm run predeploy      # integrity gate + model guard
npm run build
npx wrangler deploy
```

Record the deployed version id from the output and tag it:

```powershell
git tag deploy-<versionId>
git push origin deploy-<versionId>
```

## 2. Webhook registration (run after ANY bot token rotation)

Rotating the token is not enough: the Worker's `TELEGRAM_WEBHOOK_SECRET` and the
secret Telegram was given must match, and only `setWebhook` can tell Telegram the
new value. This one command does all three steps.

```powershell
npm run webhook:register
```

- It asks for the bot token with hidden input. The token is never read from an
  environment variable or a file, and is never printed.
- It generates a fresh 32-byte webhook secret, pushes it to the Worker with
  `wrangler secret put` over stdin, then calls `setWebhook` for the deployed route
  with `allowed_updates: [message, callback_query]`.
- It prints only the URL, `pending_update_count` and whether a
  `last_error_message` exists.

Order matters: this must run **after** the new token is active in BotFather and
**after** any deploy that changed the webhook route.

## 3. D1 backup

```powershell
npm run backup:d1
```

- Writes to `%USERPROFILE%\backups` by default, never inside the repo.
- Override with `BACKUP_DIR` (absolute path outside the repo; the script refuses
  any path inside it).
- Every export is scanned for Telegram bot token, Google API key and Groq key
  shapes. A hit prints the **line number only**, never the value.

## 4. Integrity gate

```powershell
npm run integrity
```

Fails on a module that is too small to be complete, a file ending mid-token, or a
regex literal that lost a backslash (`\s+` becoming `s+`). Runs automatically in
`npm run predeploy` and in the tracked pre-commit hook (`.githooks/pre-commit`,
enabled by `git config core.hooksPath .githooks`).

## 5. Repository location

This clone lives at:

```
C:\Users\yogid\OneDrive\Desktop\Daemon_os\personal-ai-os
```

It is inside OneDrive. That is a real risk here: this project has already lost
bytes twice (a truncated module and stripped regex backslashes) while OneDrive was
syncing. Move it out of OneDrive when convenient:

```powershell
cd C:\Users\yogid\OneDrive\Desktop\Daemon_os\personal-ai-os
git status                     # must be clean, then commit or stash
git push origin main
mkdir C:\dev
git clone https://github.com/YogiJatin/daemon_M_I.git C:\dev\personal-ai-os
cd C:\dev\personal-ai-os
npm ci
Copy-Item C:\Users\yogid\OneDrive\Desktop\Daemon_os\personal-ai-os\.dev.vars .\.dev.vars
npm run build
npm test
```

If the desktop mirror agent is registered as a scheduled task, re-register it with
the new path (check with `Get-ScheduledTask | Where-Object TaskName -like '*daemon*'`
or `schtasks /query /fo LIST | Select-String -Pattern 'Daemon'`), then delete the
old OneDrive clone only after the new one passes `npm test`.
