const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";

/** At most one setWebhook per 30 minutes. */
export const WEBHOOK_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface WebhookSyncState {
  at: string;
  action: string;
  ok: boolean;
  tg_description: string;
  last_error_message: string;
}

export interface WebhookSettings {
  WEBHOOK_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

function mentions401(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    /401\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("wrong response from the webhook")
  );
}

function parseTelegramTs(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Date.parse(value);
    return isNaN(n) ? null : Math.floor(n / 1000);
  }
  return null;
}

function readState(db: D1Database, key: string): WebhookSyncState | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: unknown }>();
  if (!row || typeof (row as any).value !== "object") return null;
  let parsed: WebhookSyncState | null = null;
  try {
    parsed = JSON.parse(String((row as any).value)) as WebhookSyncState;
  } catch {
    parsed = null;
  }
  return parsed;
}

function writeSetting(
  db: D1Database,
  key: string,
  state: WebhookSyncState,
  updatedAt: string,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  )
    .bind(key, JSON.stringify(state), updatedAt)
    .run();
}

function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(secret_token|token|secret)$/i.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  return false;
}

function safeLog(payload: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    const val = payload[key];
    if (key === "err_kind") {
      out[key] =
        (val && (val as any).constructor && (val as any).constructor.name)
          ? (val as any).constructor.name
          : "Error";
      continue;
    }
    if (isSensitiveValue(key)) continue;
    if (isSensitiveValue(val)) {
      out[key] = "<omitted>";
    } else {
      out[key] = val;
    }
  }
  console.dir(out, { depth: null });
}

export async function maybeSyncWebhook(
  settings: WebhookSettings,
  db: D1Database,
): Promise<WebhookSyncState> {
  const stateKey = "webhook_sync_state";
  const now = new Date();
  const nowIso = now.toISOString();

  const state: WebhookSyncState = {
    at: nowIso,
    action: "init",
    ok: false,
    tg_description: "unread",
    last_error_message: "",
  };

  function close(err?: unknown): WebhookSyncState {
    if (err) {
      state.action = "error";
      state.ok = false;
      state.tg_description = "unread";
      state.last_error_message =
        "error:" +
        String(
          err && (err as any).message ? (err as any).message : "unknown",
        ).slice(0, 200);
      safeLog({
        webhook_sync: "error",
        err_kind:
          err && (err as any).constructor && (err as any).constructor.name
            ? (err as any).constructor.name
            : "Error",
      });
      writeSetting(db, stateKey, state, nowIso);
    }
    return state;
  }

  if (
    typeof settings.TELEGRAM_BOT_TOKEN !== "string" ||
    !settings.TELEGRAM_BOT_TOKEN
  ) {
    state.action = "skip_missing_bot_token";
    state.ok = false;
    state.last_error_message = "telegram_bot_token_missing";
    safeLog({ webhook_sync: "skip_missing_bot_token" });
    writeSetting(db, stateKey, state, nowIso);
    return state;
  }

  if (typeof settings.WEBHOOK_URL !== "string" || !settings.WEBHOOK_URL) {
    state.action = "skip_missing_url";
    state.ok = false;
    state.last_error_message = "webhook_url_missing";
    safeLog({ webhook_sync: "skip_missing_url" });
    writeSetting(db, stateKey, state, nowIso);
    return state;
  }

  let info: Awaited<ReturnType<typeof getTelegramWebhookInfo>>;
  try {
    info = await getTelegramWebhookInfo(settings.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    return close(err);
  }

  state.tg_description = info.description ?? "unread";
  state.last_error_message = info.last_error_message ?? "none";
  safeLog({
    webhook_sync: "getWebhookInfo",
    url: info.url,
    pending_update_count: info.pending_update_count,
    last_error_date: info.last_error_date,
    last_error_message: state.last_error_message,
  });

  const last = readState(db, stateKey);
  const lastAt = last?.at ?? "1970-01-01T00:00:00.000Z";

  const codeOk = info.ok === true;
  const errDate =
    info.last_error_date != null ? Number(info.last_error_date) : null;
  const errMsg =
    (info.description != null
      ? String(info.description)
      : info.last_error_message) ?? "none";
  const mentionsBad = mentions401(errMsg) || mentions401(info.last_error_message);

  const isBad =
    errDate != null &&
    errDate > 0 &&
    (codeOk === false || mentionsBad);

  const urlMismatch = (info.url ?? "") !== settings.WEBHOOK_URL;

  if (!urlMismatch && !isBad) {
    state.action = "healthy";
    state.ok = true;
    state.last_error_message = "none";
    safeLog({ webhook_sync: "healthy", target_url: settings.WEBHOOK_URL });
    writeSetting(db, stateKey, state, nowIso);
    return state;
  }

  const lastSyncTs = Date.parse(lastAt);
  const withinCap =
    !isNaN(lastSyncTs) &&
    Date.now() - lastSyncTs < WEBHOOK_SYNC_INTERVAL_MS;
  const prevAction = last?.action;
  if (withinCap && prevAction === "setWebhook") {
    state.action = "skip_within_30m";
    state.ok = true;
    state.last_error_message = "debouncedUntil:" + lastAt;
    safeLog({ webhook_sync: "skip_within_30m", last_sync: lastAt });
    writeSetting(db, stateKey, state, nowIso);
    return state;
  }

  state.action = "setWebhook";
  let setOk = false;
  try {
    const result = await setTelegramWebhook(
      settings.TELEGRAM_BOT_TOKEN,
      settings.WEBHOOK_URL,
      settings.TELEGRAM_WEBHOOK_SECRET,
    );
    setOk = result.ok !== false;
  } catch {
    setOk = false;
  }
  state.ok = setOk;
  if (!setOk) {
    state.last_error_message = "setWebhook failed";
  } else {
    state.last_error_message = "none";
  }
  safeLog({
    webhook_sync: "setWebhook",
    ok: setOk,
    tg_description: state.tg_description,
  });
  writeSetting(db, stateKey, state, nowIso);
  return state;
}

async function getTelegramWebhookInfo(
  token: string,
): Promise<{
  ok: boolean;
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  description?: string;
}> {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API_ROOT}${token}/getWebhookInfo`, {
      method: "GET",
    });
  } catch (err) {
    return {
      ok: false,
      description: "fetch_failed",
      last_error_message: `fetch_failed:${String(
        err && (err as any).message ? (err as any).message : "unknown",
      ).slice(0, 200)}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  const data = body as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      description: "invalid_response",
      last_error_message: "invalid_response",
    };
  }

  if (data.ok === false) {
    const desc =
      data.description != null && typeof data.description === "string"
        ? String(data.description)
        : "unknown";
    return { ok: false, description: desc, last_error_message: desc };
  }

  const result = data.result as Record<string, unknown> | undefined;
  const url = result?.url as string | undefined;
  const lastErrorDate =
    result?.last_error_date == null
      ? undefined
      : Number(result.last_error_date);
  const lastErrorMessage =
    result?.last_error_message == null
      ? undefined
      : String(result.last_error_message);
  const pendingUpdateCount =
    result?.pending_update_count == null
      ? undefined
      : Number(result.pending_update_count);
  return {
    ok: true,
    url,
    pending_update_count: pendingUpdateCount,
    last_error_date: lastErrorDate,
    last_error_message: lastErrorMessage,
    description:
      result?.description != null &&
      typeof result.description === "string"
        ? String(result.description)
        : "none",
  };
}

async function setTelegramWebhook(
  token: string,
  url: string,
  secret: string,
): Promise<{ ok: boolean; description?: string }> {
  let res: Response;
  try {
    const body = JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"] as const,
      drop_pending_updates: false,
    });
    res = await fetch(`${TELEGRAM_API_ROOT}${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      description: `fetch_failed:${String(
        err && (err as any).message ? (err as any).message : "unknown",
      ).slice(0, 200)}`,
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  const payload = data as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return { ok: false, description: "invalid_response" };
  }

  if (payload.ok === false) {
    const code =
      payload.error_code != null && typeof payload.error_code === "number"
        ? payload.error_code
        : 0;
    const desc =
      payload.description != null && typeof payload.description === "string"
        ? String(payload.description)
        : "unknown";
    return { ok: false, description: `${code} ${desc}`.slice(0, 200) };
  }

  const result = payload.result as Record<string, unknown> | undefined;
  const desc =
    result?.description != null && typeof result.description === "string"
      ? String(result.description)
      : "ok";
  return { ok: true, description: desc };
}
