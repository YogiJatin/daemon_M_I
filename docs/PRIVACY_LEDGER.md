# PRIVACY LEDGER — External Hosts & Data Classification

This ledger catalogs every external network endpoint contacted by Personal AI OS, detailing the purpose, data classification, and privacy controls enforced before transmission.

---

## External Endpoints Ledger

| Host / Domain | Purpose | Data Transmitted | Data Classification | Privacy & Security Controls |
| :--- | :--- | :--- | :--- | :--- |
| `api.telegram.org` | Messaging egress & webhook reception | Bot replies, inline keyboard buttons, status templates | Operational Data | TLS 1.3 encrypted; secrets guard pre-sanitization; file download tokens never logged or persisted. |
| `api.groq.com` | Primary conversational AI & Whisper speech transcription | User intent prompts, voice note audio binaries | User Data (Sanitized) | Secrets guard scan intercepts and redacts passcodes, OTPs, cards, and Aadhaar before dispatch; no storage. |
| `api.open-meteo.com` | Daily weather forecast for Hyderabad | Latitude & longitude coordinates | Non-Personal Public Data | Zero user identity or personal context transmitted. |
| `geocoding-api.open-meteo.com` | Location geocoding for named cities | Place name string (e.g., "Hyderabad") | Non-Personal Public Data | No user coordinates, IP, or personal metadata attached. |

---

## Edge-Isolated Internal Bindings

The following services operate entirely within the Cloudflare Edge execution boundary and do NOT transit the public internet:
1. **Cloudflare D1 (`env.DB`)**: SQLite relational datastore. Owns all persistent state.
2. **Cloudflare Workers AI (`env.AI`)**: Secondary fallback inference (`@cf/meta/llama-3.1-8b-instruct-fast`). Runs directly on Cloudflare GPU workers.
3. **Healthchecks.io (`env.HEALTHCHECKS_PING_URL`)**: Optional heartbeat ping. Empty HTTP GET containing zero payload.

---

## Credential & Data Invariants

1. **Zero Secret Persistence**: API keys, bot tokens, and user credentials are stored exclusively in Cloudflare Worker encrypted secrets or local `.env` files.
2. **Untrusted Data Boundary**: All external inputs (chat text, voice transcripts, mirrored files, OCR output) are categorized as untrusted DATA and can only create proposals, never execute live mutations.
3. **Zero LLM on Cron**: Scheduled reminder loop (`worker/scheduler.ts`) never calls external AI endpoints.
