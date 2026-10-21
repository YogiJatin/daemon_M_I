#!/usr/bin/env bash
# Personal AI OS: encrypted Google Drive backup.
# Requires a dedicated BACKUP_EXPORT_TOKEN; never use the Telegram webhook secret.

set -Eeuo pipefail
umask 077

TIMESTAMP="$(date -u +"%Y%m%d_%H%M%SZ")"
EXPORT_NAME="personal_ai_os_backup_${TIMESTAMP}"
UPLOAD_NAME="${EXPORT_NAME}.json.age"
TMP_DIR=""

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Require every credential/config value before starting. An incomplete run must fail.
[[ -n "${WORKER_URL:-}" ]] || fail "Required setting WORKER_URL is missing."
[[ -n "${BACKUP_EXPORT_TOKEN:-}" ]] || fail "Required secret BACKUP_EXPORT_TOKEN is missing."
[[ -n "${AGE_PUBLIC_KEY:-}" ]] || fail "Required secret AGE_PUBLIC_KEY is missing."
[[ -n "${GOOGLE_CLIENT_ID:-}" ]] || fail "Required secret GOOGLE_CLIENT_ID is missing."
[[ -n "${GOOGLE_CLIENT_SECRET:-}" ]] || fail "Required secret GOOGLE_CLIENT_SECRET is missing."
[[ -n "${GOOGLE_REFRESH_TOKEN:-}" ]] || fail "Required secret GOOGLE_REFRESH_TOKEN is missing."
[[ -n "${GOOGLE_DRIVE_FOLDER_ID:-}" ]] || fail "Required secret GOOGLE_DRIVE_FOLDER_ID is missing."

WORKER_URL="${WORKER_URL%/}"
[[ "$WORKER_URL" == https://* ]] || fail "WORKER_URL must be an HTTPS origin."
WORKER_HOST_PATH="${WORKER_URL#https://}"
if [[ -z "$WORKER_HOST_PATH" || "$WORKER_HOST_PATH" == */* || "$WORKER_HOST_PATH" == *\?* || "$WORKER_HOST_PATH" == *\#* || "$WORKER_HOST_PATH" == *@* || "$WORKER_HOST_PATH" == *[[:space:]]* ]]; then
  fail "WORKER_URL must contain only the HTTPS origin, without a path, query, credentials, or fragment."
fi

if (( ${#BACKUP_EXPORT_TOKEN} < 32 )); then
  fail "BACKUP_EXPORT_TOKEN must be at least 32 characters."
fi
if [[ ! "$AGE_PUBLIC_KEY" =~ ^age1[0-9a-z]+$ ]]; then
  fail "AGE_PUBLIC_KEY is not in the expected age recipient format (age1...)."
fi

for command_name in curl jq age md5sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: ${command_name}."
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/personal-ai-os-backup.XXXXXX")" || fail "Could not create a private temporary directory."
PLAINTEXT_FILE="${TMP_DIR}/${EXPORT_NAME}.json"
ENCRYPTED_FILE="${TMP_DIR}/${UPLOAD_NAME}"
OAUTH_RESPONSE_FILE="${TMP_DIR}/oauth-response.json"
UPLOAD_RESPONSE_FILE="${TMP_DIR}/upload-response.json"
VERIFY_RESPONSE_FILE="${TMP_DIR}/verify-response.json"

printf '=== Starting encrypted backup [%s] ===\n' "$TIMESTAMP"
printf 'Fetching JSON export from the Worker...\n'

if ! EXPORT_HTTP_CODE="$(curl --silent --show-error --connect-timeout 15 --max-time 120 \
  --output "$PLAINTEXT_FILE" --write-out '%{http_code}' \
  --header "Authorization: Bearer ${BACKUP_EXPORT_TOKEN}" \
  --header 'Accept: application/json' \
  "${WORKER_URL}/api/v1/export?format=json")"; then
  fail "Could not reach the Worker export endpoint; response contents were not logged."
fi
[[ "$EXPORT_HTTP_CODE" == "200" ]] || fail "Worker export failed with HTTP ${EXPORT_HTTP_CODE}; response contents were not logged."

# Validate the envelope and all expected exported table arrays without printing the payload.
if ! jq -e '
  . as $root
  | ($root.ok == true)
    and (($root.data | type) == "object")
    and (($root.data.counts | type) == "object")
    and (($root.data.counts.tasks | type) == "number")
    and (($root.data.data | type) == "object")
    and (($root.data.data.tasks | type) == "array")
    and ([
      "tasks",
      "recurrence_rules",
      "timetable_semesters",
      "timetable_subjects",
      "timetable_slots",
      "timetable_materials",
      "timetable_exceptions",
      "holiday_calendar",
      "class_occurrences",
      "audit_events",
      "task_proposals",
      "audit_chain",
      "memory_objects",
      "memory_relationships",
      "memory_tags",
      "teach_sessions",
      "workflow_recipes",
      "browser_policies",
      "execution_plans"
    ] | all(. as $name | ($root.data.data[$name] | type) == "array"))
' "$PLAINTEXT_FILE" >/dev/null 2>&1; then
  fail "Worker export failed JSON/schema validation; response contents were not logged."
fi

# Check object property names for fields that should never be present in an export.
if jq -e '
  [
    .. | objects | keys[] | ascii_downcase
    | select(test("(^|_)(session_token|session_hash|token_hash|pairing_challenges|telegram_updates|bot_token|access_token|refresh_token|webhook_secret|client_secret|private_key|auth_sessions|api_key|secret_key|secrets?)(_|$)"))
  ] | length > 0
' "$PLAINTEXT_FILE" >/dev/null 2>&1; then
  fail "Export contains a forbidden credential-related field name; plaintext was not uploaded."
fi

TASK_COUNT="$(jq -r '.data.counts.tasks' "$PLAINTEXT_FILE")"
printf 'Export validated; task count: %s.\n' "$TASK_COUNT"

printf 'Encrypting export with age...\n'
if ! age --recipient "$AGE_PUBLIC_KEY" --output "$ENCRYPTED_FILE" "$PLAINTEXT_FILE" >/dev/null 2>&1; then
  fail "Encryption failed; no backup was uploaded."
fi
[[ -s "$ENCRYPTED_FILE" ]] || fail "Encryption produced an empty archive."

# Remove plaintext before any upload request; the EXIT trap also removes the temp directory.
rm -f -- "$PLAINTEXT_FILE" || fail "Could not remove the plaintext export."
printf 'Plaintext export removed; encrypted archive created.\n'
ENCRYPTED_SIZE="$(wc -c < "$ENCRYPTED_FILE" | tr -d '[:space:]')"
LOCAL_MD5="$(md5sum "$ENCRYPTED_FILE" | cut -d ' ' -f 1)"
printf 'Refreshing Google Drive access token...\n'

if ! OAUTH_HTTP_CODE="$(curl --silent --show-error --connect-timeout 15 --max-time 60 \
  --output "$OAUTH_RESPONSE_FILE" --write-out '%{http_code}' \
  --request POST 'https://oauth2.googleapis.com/token' \
  --data-urlencode "client_id=${GOOGLE_CLIENT_ID}" \
  --data-urlencode "client_secret=${GOOGLE_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${GOOGLE_REFRESH_TOKEN}" \
  --data-urlencode 'grant_type=refresh_token')"; then
  fail "Google OAuth token refresh request failed; response contents were not logged."
fi
[[ "$OAUTH_HTTP_CODE" == "200" ]] || fail "Google OAuth token refresh failed with HTTP ${OAUTH_HTTP_CODE}; response contents were not logged."
if ! ACCESS_TOKEN="$(jq -er '.access_token | select(type == "string" and length > 0)' "$OAUTH_RESPONSE_FILE" 2>/dev/null)"; then
  fail "Google OAuth response did not contain a usable access token."
fi
rm -f -- "$OAUTH_RESPONSE_FILE"

METADATA="$(jq -cn \
  --arg name "$UPLOAD_NAME" \
  --arg folder "$GOOGLE_DRIVE_FOLDER_ID" \
  '{name: $name, parents: [$folder], mimeType: "application/octet-stream"}')"

printf 'Uploading encrypted archive to the configured Google Drive folder...\n'
if ! UPLOAD_HTTP_CODE="$(curl --silent --show-error --connect-timeout 15 --max-time 180 \
  --output "$UPLOAD_RESPONSE_FILE" --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  --form "metadata=${METADATA};type=application/json;charset=UTF-8" \
  --form "file=@${ENCRYPTED_FILE};type=application/octet-stream" \
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum,mimeType,parents")"; then
  fail "Google Drive upload request failed; response contents were not logged."
fi
if [[ "$UPLOAD_HTTP_CODE" != "200" && "$UPLOAD_HTTP_CODE" != "201" ]]; then
  fail "Google Drive upload failed with HTTP ${UPLOAD_HTTP_CODE}; response contents were not logged."
fi

if ! jq -e \
  --arg name "$UPLOAD_NAME" \
  --arg folder "$GOOGLE_DRIVE_FOLDER_ID" \
  --arg size "$ENCRYPTED_SIZE" \
  --arg md5 "$LOCAL_MD5" \
  '(.id | type == "string" and length > 0)
   and (.name == $name)
   and ((.size | tostring) == $size)
   and (.md5Checksum == $md5)
   and (((.parents // []) | index($folder)) != null)' \
  "$UPLOAD_RESPONSE_FILE" >/dev/null 2>&1; then
  fail "Google Drive upload response did not match the expected name, folder, size, or checksum."
fi
FILE_ID="$(jq -er '.id | select(type == "string" and length > 0)' "$UPLOAD_RESPONSE_FILE")"
rm -f -- "$UPLOAD_RESPONSE_FILE"

# Read back Drive metadata so success means the uploaded object is retrievable and intact.
printf 'Verifying uploaded Drive object...\n'
if ! VERIFY_HTTP_CODE="$(curl --silent --show-error --connect-timeout 15 --max-time 60 \
  --output "$VERIFY_RESPONSE_FILE" --write-out '%{http_code}' \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://www.googleapis.com/drive/v3/files/${FILE_ID}?fields=id,name,size,md5Checksum,parents")"; then
  fail "Could not verify the uploaded Google Drive object; response contents were not logged."
fi
[[ "$VERIFY_HTTP_CODE" == "200" ]] || fail "Google Drive verification failed with HTTP ${VERIFY_HTTP_CODE}; response contents were not logged."
if ! jq -e \
  --arg id "$FILE_ID" \
  --arg name "$UPLOAD_NAME" \
  --arg folder "$GOOGLE_DRIVE_FOLDER_ID" \
  --arg size "$ENCRYPTED_SIZE" \
  --arg md5 "$LOCAL_MD5" \
  '(.id == $id)
   and (.name == $name)
   and ((.size | tostring) == $size)
   and (.md5Checksum == $md5)
   and (((.parents // []) | index($folder)) != null)' \
  "$VERIFY_RESPONSE_FILE" >/dev/null 2>&1; then
  fail "Google Drive read-back verification failed; backup will not be reported as successful."
fi

printf 'Verified encrypted backup in Google Drive (%s bytes).\n' "$ENCRYPTED_SIZE"
printf '=== Backup completed successfully [%s] ===\n' "$TIMESTAMP"
