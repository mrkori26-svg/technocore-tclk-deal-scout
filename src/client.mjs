import { OFFER_ROOM, parseRoomExport, parseRoomWindow } from "./core.mjs";

export const DEFAULT_BASE_URL = "https://technocore.chat";

export async function fetchRoomWindow(room = OFFER_ROOM, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const url = new URL(`/r/${encodeURIComponent(room)}`, `${baseUrl}/`);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(options.limit ?? 200));
  if (Number.isSafeInteger(options.since)) url.searchParams.set("since", String(options.since));
  if (options.wait) url.searchParams.set("wait", String(options.wait));

  const response = await getWithRetry(url, options);
  const raw = await response.text();
  const parsed = parseRoomWindow(room, raw, {
    expectedSince: options.since,
    generation: response.headers.get("x-room-generation"),
  });
  return {
    ...parsed,
    raw,
    source: {
      ...parsed.source,
      mode: "live",
      baseUrl,
      generation: parsed.source.generation ?? response.headers.get("x-room-generation"),
    },
  };
}

export async function fetchRoomExport(room, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const url = new URL(`/r/${encodeURIComponent(room)}/export`, `${baseUrl}/`);
  const response = await getWithRetry(url, options);
  const raw = await response.text();
  const parsed = parseRoomExport(room, raw, {
    generation: response.headers.get("x-room-generation"),
  });
  return {
    ...parsed,
    raw,
    source: {
      ...parsed.source,
      mode: "live",
      baseUrl,
    },
  };
}

export async function getWithRetry(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch is not available in this runtime");
  const attempts = options.attempts ?? 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json, application/x-ndjson, text/plain" },
        signal: options.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt === attempts) break;
      await wait(backoffMs(attempt), options.signal);
      continue;
    }

    if (response.ok) return response;
    const body = (await response.text()).slice(0, 500).trim();
    lastError = new Error(`Technocore returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    if (![429, 502, 503, 504].includes(response.status) || attempt === attempts) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await wait(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 15_000) : backoffMs(attempt), options.signal);
  }

  throw lastError instanceof Error ? lastError : new Error("Technocore request failed");
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Technocore base URL must use HTTPS");
  }
  return url.href.replace(/\/$/, "");
}

function backoffMs(attempt) {
  return Math.min(500 * (2 ** (attempt - 1)), 5_000);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
