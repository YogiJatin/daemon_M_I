#!/usr/bin/env bash
# Personal AI OS: encrypted backup to Google Drive through a guarded Apps Script gateway.
# Only the age-encrypted archive is sent to the gateway. Never use the Telegram webhook secret.

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

# Require every credential/config value before doing work.
[[ -n "${WORKER_URL:-}" ]] || fail "Required setting WORKER_URL is missing."
[[ -n "${BACKUP_EXPORT_TOKEN:-}" ]] || fail "Required secret BACKUP_EXPORT_TOKEN is missing."
[[ -n "${AGE_PUBLIC_KEY:-}" ]] || fail "Required secret AGE_PUBLIC_KEY is missing."
[[ -n "${DRIVE_UPLOAD_URL:-}" ]] || fail "Required secret DRIVE_UPLOAD_URL is missing."
[[ -n "${DRIVE_UPLOAD_SECRET:-}" ]] || fail "Required secret DRIVE_UPLOAD_SECRET is missing."

WORKER_URL="${WORKER_URL%/}"
[[ "$WORKER_URL" == https://* ]] || fail "WORKER_URL must be an HTTPS origin."
WORKER_HOST_PATH="${WORKER_URL#https://}"
if [[ -z "$WORKER_HOST_PATH" || "$WORKER_HOST_PATH" == */* || "$WORKER_HOST_PATH" == *\?* || "$WORKER_HOST_PATH" == *\#* || "$WORKER_HOST_PATH" == *@* || "$WORKER_HOST_PATH" == *[[:space:]]* ]]; then
  fail "WORKER_URL must contain only the HTTPS origin, without a path, query, credentials, or fragment."
fi

if (( ${#BACKUP_EXPORT_TOKEN} < 32 )); then
  fail "BACKUP_EXPORT_TOKEN must be at least 32 characters."
fi
if (( ${#DRIVE_UPLOAD_SECRET} < 32 )); then
  fail "DRIVE_UPLOAD_SECRET must be at least 32 characters."
fi
if [[ ! "$AGE_PUBLIC_KEY" =~ ^age1[0-9a-z]+$ ]]; then
  fail "AGE_PUBLIC_KEY is not in the expected age recipient format (age1...)."
fi
if [[ ! "$DRIVE_UPLOAD_URL" =~ ^https://script\.google\.com/macros/s/[^/?#]+/exec$ ]]; then
  fail "DRIVE_UPLOAD_URL must be a Google Apps Script web-app URL ending in /exec."
fi

for command_name in curl jq age sha256sum base64; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: ${command_name}."
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/personal-ai-os-backup.XXXXXX")" || fail "Could not create a private temporary directory."
PLAINTEXT_FILE="${TMP_DIR}/${EXPORT_NAME}.json"
ENCRYPTED_FILE="${TMP_DIR}/${UPLOAD_NAME}"
BASE64_FILE="${TMP_DIR}/encrypted.b64"
REQUEST_FILE="${TMP_DIR}/gateway-request.json"
RESPONSE_FILE="${TMP_DIR}/gateway-response.json"

printf '=== Starting encrypted Google Drive backup [%s] ===\n' "$TIMESTAMP"
printf 'Fetching JSON export from the Worker...\n'

if ! EXPORT_HTTP_CODE="$(curl --silent --show-error --connect-timeout 15 --max-time 120 \
  --output "$PLAINTEXT_FILE" --write-out '%{http_code}' \
  --header "Authorization: Bearer ${BACKUP_EXPORT_TOKEN}" \
  --header 'Accept: application/json' \
  "${WORKER_URL}/api/v1/export?format=json")"; then
  fail "Could not reach the Worker export endpoint; response contents were not logged."
fi
[[ "$EXPORT_HTTP_CODE" == "200" ]] || fail "Worker export failed with HTTP ${EXPORT_HTTP_CODE}; response contents were not logged."

# Validate the envelope and exported table arrays without printing the payload.
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

# Reject suspicious credential-related property names before encrypting the export.
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

# Plaintext must be removed before any upload request.
rm -f -- "$PLAINTEXT_FILE" || fail "Could not remove the plaintext export."
printf 'Plaintext export removed; encrypted archive created.\n'

ENCRYPTED_SIZE="$(wc -c < "$ENCRYPTED_FILE" | tr -d '[:space:]')"
# The Apps Script gateway is intentionally capped at 5 MiB; base64 makes the request larger.
if (( ENCRYPTED_SIZE > 5242880 )); then
  fail "Encrypted archive exceeds the gateway's 5 MiB file limit; no upload was attempted."
fi
LOCAL_SHA256="$(sha256sum "$ENCRYPTED_FILE" | cut -d ' ' -f 1)"
base64 --wrap=0 "$ENCRYPTED_FILE" > "$BASE64_FILE"

# jq reads base64 from a file instead of passing a large archive on the command line.
if ! jq -n \
  --arg token "$DRIVE_UPLOAD_SECRET" \
  --arg name "$UPLOAD_NAME" \
  --arg sha256 "$LOCAL_SHA256" \
  --argjson sizeBytes "$ENCRYPTED_SIZE" \
  --rawfile contentBase64 "$BASE64_FILE" \
  '{token: $token, name: $name, sha256: $sha256, sizeBytes: $sizeBytes, contentBase64: $contentBase64}' \
  > "$REQUEST_FILE"; then
  fail "Could not prepare the encrypted upload request."
fi

REQUEST_SIZE="$(wc -c < "$REQUEST_FILE" | tr -d '[:space:]')"
if (( REQUEST_SIZE > 7500000 )); then
  fail "Encoded request exceeds the Apps Script gateway request limit; no upload was attempted."
fi
rm -f -- "$BASE64_FILE"

printf 'Uploading encrypted archive through the Google Drive gateway...\n'
# Apps Script ContentService responses may redirect to script.googleusercontent.com; follow redirects.
if ! UPLOAD_HTTP_CODE="$(curl --location --silent --show-error --connect-timeout 15 --max-time 240 --max-redirs 5 \
  --output "$RESPONSE_FILE" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data-binary "@${REQUEST_FILE}" \
  "$DRIVE_UPLOAD_URL")"; then
  fail "Apps Script upload request failed; response contents were not logged."
fi
[[ "$UPLOAD_HTTP_CODE" == "200" ]] || fail "Apps Script gateway returned HTTP ${UPLOAD_HTTP_CODE}; response contents were not logged."

if ! jq -e \
  --arg name "$UPLOAD_NAME" \
  --arg sha256 "$LOCAL_SHA256" \
  --argjson sizeBytes "$ENCRYPTED_SIZE" \
  '(.ok == true)
   and (.id | type == "string" and length > 0)
   and (.name == $name)
   and (.sizeBytes == $sizeBytes)
   and (.sha256 == $sha256)
   and (.reused | type == "boolean")' \
  "$RESPONSE_FILE" >/dev/null 2>&1; then
  GATEWAY_ERROR="$(jq -r '.error // "unexpected_response" | if type == "string" and test("^[a-z_]+$") then . else "unexpected_response" end' "$RESPONSE_FILE" 2>/dev/null || printf 'unexpected_response')"
  fail "Google Drive gateway did not verify the uploaded archive (error code: ${GATEWAY_ERROR})."
fi

rm -f -- "$REQUEST_FILE" "$RESPONSE_FILE"
printf 'Verified encrypted backup in Google Drive (%s bytes; SHA-256 matched).\n' "$ENCRYPTED_SIZE"
printf '=== Backup completed successfully [%s] ===\n' "$TIMESTAMP"
