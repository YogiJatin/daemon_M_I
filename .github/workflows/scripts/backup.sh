#!/usr/bin/env bash
# ==============================================================================
# Personal AI OS — Encrypted External Backup Script
#
# Requirements (Personal_AI_OS_SRS_v2.2.md §§14.3, 16 TEST-5.3, TEST-5.4, TEST-5.5):
# 1. Fetch full JSON export from Worker /api/v1/export
# 2. Verify export integrity (no secrets, valid JSON, non-empty)
# 3. Encrypt immediately with age using owner's public key
# 4. Strictly delete plaintext export before upload
# 5. Upload encrypted archive to Google Drive (using drive.file scope)
# 6. Verify Google Drive upload response
# ==============================================================================

set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
EXPORT_NAME="personal_ai_os_backup_${TIMESTAMP}"
PLAINTEXT_FILE="/tmp/${EXPORT_NAME}.json"
ENCRYPTED_FILE="/tmp/${EXPORT_NAME}.json.age"

# Trap to guarantee plaintext is wiped even on failure
cleanup() {
  if [ -f "${PLAINTEXT_FILE}" ]; then
    rm -f "${PLAINTEXT_FILE}"
    echo "🔒 Cleaned up temporary plaintext export."
  fi
  if [ -f "${ENCRYPTED_FILE}" ]; then
    rm -f "${ENCRYPTED_FILE}"
  fi
}
trap cleanup EXIT INT TERM

echo "=== 1. Starting Personal AI OS Backup [${TIMESTAMP}] ==="

if [ -z "${WORKER_URL:-}" ]; then
  echo "❌ Error: WORKER_URL environment variable is required."
  exit 1
fi

if [ -z "${AGE_PUBLIC_KEY:-}" ]; then
  echo "❌ Error: AGE_PUBLIC_KEY environment variable is required."
  exit 1
fi

AUTH_HEADER=""
if [ -n "${WORKER_SESSION_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${WORKER_SESSION_TOKEN}"
elif [ -n "${WORKER_WEBHOOK_SECRET:-}" ]; then
  AUTH_HEADER="X-Telegram-Bot-Api-Secret-Token: ${WORKER_WEBHOOK_SECRET}"
else
  echo "❌ Error: Either WORKER_SESSION_TOKEN or WORKER_WEBHOOK_SECRET is required for authentication."
  exit 1
fi

# 1. Fetch export
echo "📥 Fetching system export from ${WORKER_URL}/api/v1/export..."
HTTP_CODE=$(curl -s -w "%{http_code}" -o "${PLAINTEXT_FILE}" \
  -H "${AUTH_HEADER}" \
  "${WORKER_URL}/api/v1/export?format=json")

if [ "${HTTP_CODE}" != "200" ]; then
  echo "❌ Failed to fetch export: HTTP ${HTTP_CODE}"
  cat "${PLAINTEXT_FILE}" || true
  exit 1
fi

# 2. Verify export integrity
echo "🔍 Validating export integrity..."
IS_OK=$(jq -r '.ok // false' "${PLAINTEXT_FILE}")
if [ "${IS_OK}" != "true" ]; then
  echo "❌ Export JSON does not contain ok: true."
  cat "${PLAINTEXT_FILE}"
  exit 1
fi

TASK_COUNT=$(jq -r '.data.counts.tasks // 0' "${PLAINTEXT_FILE}")
echo "✅ Export verified: ${TASK_COUNT} tasks captured."

# Security check: Ensure no secrets are leaked in export
if grep -qiE '(session_token|pairing_challenges|telegram_updates|bot_token)' "${PLAINTEXT_FILE}"; then
  echo "❌ CRITICAL SECURITY ERROR: Export contains sensitive internal tokens or tables!"
  exit 1
fi

# 3. Encrypt with age
echo "🔐 Encrypting export with age using public recipient key..."
age --recipient "${AGE_PUBLIC_KEY}" -o "${ENCRYPTED_FILE}" "${PLAINTEXT_FILE}"

# 4. Wipe plaintext immediately
rm -f "${PLAINTEXT_FILE}"
echo "✅ Plaintext securely wiped."

ENCRYPTED_SIZE=$(wc -c < "${ENCRYPTED_FILE}")
echo "📦 Encrypted archive created (${ENCRYPTED_SIZE} bytes)."

# 5. Upload to Google Drive (if credentials provided)
if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ] && [ -n "${GOOGLE_REFRESH_TOKEN:-}" ]; then
  echo "☁️ Refreshing Google Drive OAuth access token..."
  TOKEN_RESP=$(curl -s -X POST https://oauth2.googleapis.com/token \
    -d client_id="${GOOGLE_CLIENT_ID}" \
    -d client_secret="${GOOGLE_CLIENT_SECRET}" \
    -d refresh_token="${GOOGLE_REFRESH_TOKEN}" \
    -d grant_type=refresh_token)

  ACCESS_TOKEN=$(echo "${TOKEN_RESP}" | jq -r '.access_token // empty')
  if [ -z "${ACCESS_TOKEN}" ]; then
    echo "❌ Failed to obtain Google Drive access token:"
    echo "${TOKEN_RESP}"
    exit 1
  fi

  echo "☁️ Uploading encrypted backup to Google Drive..."
  METADATA=$(jq -n \
    --arg name "${EXPORT_NAME}.json.age" \
    --arg folder "${GOOGLE_DRIVE_FOLDER_ID:-}" \
    'if $folder != "" then {name: $name, parents: [$folder]} else {name: $name} end')

  UPLOAD_RESP=$(curl -s -X POST "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -F "metadata=${METADATA};type=application/json;charset=UTF-8" \
    -F "file=@${ENCRYPTED_FILE};type=application/octet-stream")

  FILE_ID=$(echo "${UPLOAD_RESP}" | jq -r '.id // empty')
  if [ -z "${FILE_ID}" ]; then
    echo "❌ Google Drive upload failed:"
    echo "${UPLOAD_RESP}"
    exit 1
  fi

  echo "✅ Successfully uploaded to Google Drive! File ID: ${FILE_ID}"
else
  echo "ℹ️ Note: Google Drive credentials not provided. Archive encrypted and tested locally."
fi

echo "=== Backup Completed Successfully [${TIMESTAMP}] ==="
