# Personal AI OS ("Daemon")

A single-owner personal operations system: a Telegram bot backed by a Cloudflare Worker and D1,
with a desktop mirror and a React dashboard. Tasks, recurrence, timetable, notifications and
audit state live in D1 only.

Canonical requirements: `Personal_AI_OS_SRS_v2.2.md`. Coding contract: `AGENTS.md`.

## Layout

| Path | What lives there |
| --- | --- |
| `worker/` | The Worker: webhook, Telegram conversation, scheduler, AI adapter, services |
| `migrations/` | D1 migrations, applied in order (`0025` is the latest) |
| `tests/unit_*.ts` | Standalone unit suites; each exits non-zero on failure |
| `tests/evals/` | `daemon_eval.jsonl`, the 60-case behaviour dataset |
| `scripts/` | Deploy guard, test runners, eval runner, device pairing |
| `src/` | React dashboard (Vite) |
| `desktop_agent/` | Local mirror agent (fixed adapters only) |
| `docs/` | Decisions (ADR), design, audit, privacy ledger, restore runbook |

## Local development

```bash
npm install
npx wrangler dev            # Worker on http://localhost:8787
npm run dev                 # dashboard (Vite)
```

Local secrets go in `.dev.vars` (gitignored). Variable names, never values, are listed in
`.env.example`. Production values are Worker secrets: `npx wrangler secret put NAME`.

## Checks

```bash
npx tsc -b                        # typecheck worker + app
npm test                          # every tests/unit_*.ts suite
npm test -- guard                 # only suites whose filename matches
npm run eval:live                 # 60-case eval against the real provider chain
npm run eval:live -- --only d,g   # deterministic + guard cases only (no provider key needed)
```

`eval:live` reads provider keys from `.dev.vars` and never writes to D1 or Telegram. Without a
key it prints `BLOCKED` and exits 2 instead of reporting provider errors as behaviour failures.

CI (`.github/workflows/ci.yml`) runs typecheck, the unit suites and Gitleaks on every push.
CI is not the scheduler and holds no production secrets.

## Deploy

```bash
npm run deploy        # deploy guard -> build -> wrangler deploy
```

The deploy guard (`scripts/deploy_model_guard.ts`) verifies the model/provider configuration
before a release. Migrations: `npx wrangler d1 migrations apply personal-ai-os-db --remote`,
after taking a backup (see `RUNBOOK.md`).

## Rules worth repeating

- No AI extraction in the V0 reminder loop; manual entry is the source of truth.
- Timezone is IST only; absolute instants are stored in UTC.
- Never claim a side effect that D1 did not commit.
- Production behaviours (cron, Telegram delivery, provider fallback, backup restore) can only be
  confirmed live, not by mocks.
