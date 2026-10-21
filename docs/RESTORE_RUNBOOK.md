# Personal AI OS — Backup & Restore Runbook

> **Target Audience:** Owner (Jatin)  
> **Relevant Requirements:** SRS §§14.3, 16 TEST-5.3, TEST-5.4, TEST-5.5

---

## 1. Overview & Security Architecture

The Personal AI OS uses a zero-trust external backup architecture:
- **Weekly Schedule:** Triggered via GitHub Actions every Saturday at 02:00 UTC (07:30 IST).
- **Source of Truth:** Authenticated Cloudflare Worker endpoint `GET /api/v1/export?format=json`.
- **Encryption:** Encrypted client-side with [`age`](https://github.com/FiloSottile/age) before leaving the runner.
- **Key Separation:**
  - **Public Encryption Key:** Stored in GitHub Secrets (`AGE_PUBLIC_KEY`). Can only encrypt.
  - **Private Decryption Key:** Held **strictly offline** on the owner's PC. Never committed, never uploaded to CI, never sent to Cloudflare.
- **Destination:** Owner's personal Google Drive via scoped OAuth (`drive.file`).

---

## 2. One-Time Setup Instructions

### A. Generate `age` Keypair (On Owner's PC)

1. Install `age`:
   ```powershell
   winget install age
   ```
2. Generate an offline keypair:
   ```powershell
   age-keygen -o C:\Users\yogid\.age\personal_ai_os_backup_key.txt
   ```
3. View the public recipient key:
   ```powershell
   Get-Content C:\Users\yogid\.age\personal_ai_os_backup_key.txt | Select-String "public key:"
   # Example: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
   ```
4. **Action:** Copy this public key to GitHub repository secrets as `AGE_PUBLIC_KEY`.  
   **Crucial:** Keep `personal_ai_os_backup_key.txt` offline and backed up securely (e.g. password manager).

### B. Configure Google Drive Scoped Access

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create or select a project, enable **Google Drive API**.
3. Create an **OAuth 2.0 Client ID** (Desktop Application or Web).
4. Configure consent screen with `https://www.googleapis.com/auth/drive.file` scope (least privilege: only accesses files created by this application).
5. Obtain a refresh token for your Google account and set the following GitHub Secrets:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `GOOGLE_DRIVE_FOLDER_ID` (Optional: specific folder ID)

### C. Configure Worker Secrets in GitHub

Set the following secrets in your GitHub repository:
- `WORKER_URL`: Your deployed Worker URL (e.g. `https://personal-ai-os.<your-subdomain>.workers.dev`)
- `WORKER_SESSION_TOKEN`: An active owner session token from `/api/v1/auth/pair`, OR:
- `WORKER_WEBHOOK_SECRET`: Your configured Telegram webhook secret (allows backup verification)

---

## 3. How to Restore an Encrypted Backup (Disaster Recovery Drill)

When disaster recovery is needed, follow these steps:

### Step 1: Download the Encrypted Backup
Download `personal_ai_os_backup_YYYYMMDD_HHMMSSZ.json.age` from your Google Drive to your local machine.

### Step 2: Decrypt with `age`
Run the following PowerShell command:
```powershell
age --decrypt -i C:\Users\yogid\.age\personal_ai_os_backup_key.txt `
  personal_ai_os_backup_20261021_120000Z.json.age > restore.json
```

### Step 3: Verify Integrity & Inspect Record Counts
Open `restore.json` or inspect via PowerShell:
```powershell
Get-Content restore.json | ConvertFrom-Json | Select-Object -ExpandProperty counts
```
You should see all record counts matching the snapshot:
```json
{
  "tasks": 25,
  "recurrence_rules": 4,
  "timetable_semesters": 1,
  "timetable_subjects": 5,
  "timetable_slots": 14,
  "timetable_materials": 8,
  "class_occurrences": 30,
  "audit_events": 78
}
```

### Step 4: Verify Zero Leaked Secrets
Ensure no tokens, credentials, or session hashes are present:
```powershell
Select-String -Path restore.json -Pattern "session_token|pairing_challenges|telegram_updates"
# Must return NO matches!
```

### Step 5: Restore Into D1 (Non-Production / Local Drill)
To restore records back into a local or recovery database:
1. Ensure migrations 0001–0008 are applied on the target D1 database.
2. Read the `restore.json` payload and insert the records via a recovery script or D1 batches.

---

## 4. Troubleshooting & Failure Recovery

| Issue | Cause | Action |
|-------|-------|--------|
| GitHub Action fails with HTTP 401 | Expired session token or wrong secret | Update `WORKER_SESSION_TOKEN` or `WORKER_WEBHOOK_SECRET` in GitHub Secrets |
| Age encryption fails | Invalid public key | Verify `AGE_PUBLIC_KEY` begins with `age1...` |
| Google Drive fails with 401 | Invalid refresh token | Regenerate OAuth refresh token in Google Cloud Console |
| No backups appearing | Workflow disabled | In GitHub Actions, ensure workflow is enabled (scheduled workflows pause after 60 days of inactivity on public repos) |
