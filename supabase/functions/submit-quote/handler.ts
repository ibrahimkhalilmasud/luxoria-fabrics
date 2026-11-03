// Quotation intake for the Luxoria site.
// Validates the request, rate-limits by hashed IP, stores the quote with the secret key,
// then alerts the owner by WhatsApp (CallMeBot) and email (Resend).
// No third-party imports so it runs unchanged in Supabase Edge (Deno) and in `deno test`.

export interface Env {
  supabaseUrl: string;
  serviceKey: string;
  allowedOrigins: string[];
  siteUrl: string;
  ipSalt: string;
  callmebotPhone?: string;
  callmebotApiKey?: string;
  resendApiKey?: string;
  adminEmail?: string;
  resendFrom?: string;
}

export interface QuoteInput {
  channel: "quotation" | "whatsapp" | "email";
  requestType: string;
  name: string;
  whatsapp: string;
  email: string | null;
  message: string | null;
  items: string[];
}

interface ProductInfo {
  id: string;
  article?: string;
  name?: string;
  designNo?: string;
  quantity?: number | null;
  collection?: string;
  category?: string;
  colourFamily?: string;
  status?: string;
}

/** Admin corrections (table product_edits), column -> product field. */
const EDIT_FIELDS: Record<string, keyof ProductInfo> = {
  article: "article", name: "name", design_no: "designNo", quantity: "quantity",
  category: "category", colour_family: "colourFamily", status: "status",
};

type PriceMap = Map<string, { price: number; currency: string }>;

const CHANNELS = ["quotation", "whatsapp", "email"] as const;
const REQUEST_TYPES = ["Quotation", "Swatches", "Private viewing", "Video walkthrough"];
const MAX_BODY_BYTES = 20_000;
const MAX_ITEMS = 200;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PRODUCT_ID = /^[a-z0-9-]{1,60}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class ValidationError extends Error {}

function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max + 1);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim().slice(0, max + 1);
}

export function normaliseWhatsapp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().replace(/[\s().-]/g, "");
  if (v.startsWith("00")) v = "+" + v.slice(2);
  if (!v.startsWith("+")) v = "+" + v;
  return /^\+[0-9]{7,15}$/.test(v) ? v : null;
}

export function validate(body: unknown): QuoteInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Invalid request.");
  const b = body as Record<string, unknown>;
  if (typeof b.website === "string" && b.website.trim() !== "") throw new ValidationError("Invalid request.");

  const channel = CHANNELS.find((c) => c === b.channel);
  if (!channel) throw new ValidationError("Invalid channel.");
  const requestType = REQUEST_TYPES.find((t) => t === b.requestType);
  if (!requestType) throw new ValidationError("Please choose a request type.");

  const name = cleanLine(b.name, 80);
  if (name.length < 2 || name.length > 80) throw new ValidationError("Please enter your name.");

  const whatsapp = normaliseWhatsapp(b.whatsapp);
  if (!whatsapp) throw new ValidationError("Please enter a valid WhatsApp number with country code.");

  const emailRaw = cleanLine(b.email, 254);
  if (emailRaw && (emailRaw.length > 254 || !EMAIL.test(emailRaw))) {
    throw new ValidationError("Please enter a valid email address.");
  }

  const message = cleanText(b.message, 1000);
  if (message.length > 1000) throw new ValidationError("Message is too long (1000 characters max).");

  if (!Array.isArray(b.items)) throw new ValidationError("Your cart is empty.");
  if (b.items.length > MAX_ITEMS) throw new ValidationError("Too many items in one request.");
  const items = [...new Set(b.items.filter((x): x is string => typeof x === "string" && PRODUCT_ID.test(x)))];
  if (!items.length) throw new ValidationError("Your cart is empty.");

  return { channel, requestType, name, whatsapp, email: emailRaw || null, message: message || null, items };
}

export function makeRef(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(8)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return (req.headers.get("cf-connecting-ip") ?? fwd.split(",")[0] ?? "").trim() || "unknown";
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = origin && env.allowedOrigins.includes(origin) ? origin : "";
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status: number, data: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function restHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = { apikey: env.serviceKey, "Content-Type": "application/json" };
  // Legacy service_role keys are JWTs and must also be sent as a bearer token.
  if (env.serviceKey.startsWith("ey")) h.Authorization = `Bearer ${env.serviceKey}`;
  return h;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function itemLine(p: ProductInfo, price?: { price: number; currency: string }): string {
  return [
    p.name ? `${p.name} (${p.article ?? p.id})` : p.article ?? p.id,
    p.designNo,
    p.quantity != null ? `${p.quantity} m` : null,
    price ? `${price.currency === "MYR" ? "RM" : price.currency} ${Number(price.price).toFixed(2)}/m` : null,
  ].filter(Boolean).join(" · ");
}

export function buildAlertText(ref: string, q: QuoteInput, items: ProductInfo[], prices: PriceMap, siteUrl: string): string {
  const lines = [
    `New ${q.requestType.toLowerCase()} request ${ref}`,
    `Client: ${q.name}`,
    `WhatsApp: ${q.whatsapp}`,
    ...(q.email ? [`Email: ${q.email}`] : []),
    `Sent via: ${q.channel}`,
    "",
    `Items (${items.length}):`,
    ...items.map((p, i) => `${i + 1}. ${itemLine(p, prices.get(p.id))}`),
    ...(q.message ? ["", `Message: ${q.message}`] : []),
    "",
    `Admin: ${siteUrl.replace(/\/$/, "")}/admin/`,
  ];
  const text = lines.join("\n");
  return text.length > 1800 ? text.slice(0, 1790) + "\n…" : text;
}

let catalogCache: { at: number; map: Map<string, ProductInfo> } | null = null;

export function resetCatalogCache(): void {
  catalogCache = null;
}

async function loadBaseCatalog(env: Env, f: typeof fetch, now: number): Promise<Map<string, ProductInfo> | null> {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.map;
  try {
    const res = await f(`${env.siteUrl.replace(/\/$/, "")}/data/products.json`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return catalogCache?.map ?? null;
    const data = await res.json() as { products?: ProductInfo[] };
    const map = new Map((data.products ?? []).map((p) => [p.id, {
      id: p.id, article: p.article, name: p.name, designNo: p.designNo, quantity: p.quantity,
      collection: p.collection, category: p.category, colourFamily: p.colourFamily, status: p.status,
    }]));
    catalogCache = { at: now, map };
    return map;
  } catch (err) {
    console.error("catalog fetch failed", err);
    return catalogCache?.map ?? null;
  }
}

/** Edit rows for the given products; empty when unavailable, so quotes still go through. */
async function loadEdits(env: Env, f: typeof fetch, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  try {
    const cols = ["product_id", ...Object.keys(EDIT_FIELDS)].join(",");
    const res = await f(`${env.supabaseUrl}/rest/v1/product_edits?select=${cols}&product_id=in.(${ids.join(",")})`, {
      headers: restHeaders(env), signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return new Map();
    const rows = await res.json() as Record<string, unknown>[];
    return new Map(rows.map((r) => [String(r.product_id), r]));
  } catch (err) {
    console.error("edits fetch failed", err);
    return new Map();
  }
}

/** The requested products as the website shows them now (edits applied, hidden ones removed). */
async function loadItems(env: Env, f: typeof fetch, now: number, ids: string[]): Promise<ProductInfo[]> {
  const catalog = await loadBaseCatalog(env, f, now);
  if (!catalog) return ids.map((id) => ({ id }));
  const known = ids.filter((id) => catalog.has(id));
  const edits = known.length ? await loadEdits(env, f, known) : new Map();
  return known
    .map((id) => {
      const row = edits.get(id);
      if (!row) return catalog.get(id)!;
      const p: ProductInfo = { ...catalog.get(id)! };
      for (const [col, field] of Object.entries(EDIT_FIELDS)) (p as unknown as Record<string, unknown>)[field] = row[col] ?? undefined;
      p.quantity = row.quantity == null ? null : Number(row.quantity);
      return p;
    })
    .filter((p) => p.status !== "hidden");
}

async function recentCount(env: Env, f: typeof fetch, ipHash: string, sinceIso: string): Promise<number> {
  const url = `${env.supabaseUrl}/rest/v1/quotes?select=id&ip_hash=eq.${ipHash}` +
    `&created_at=gt.${encodeURIComponent(sinceIso)}&limit=${RATE_MAX}`;
  const res = await f(url, { headers: restHeaders(env) });
  if (!res.ok) throw new Error(`rate check failed: ${res.status}`);
  return (await res.json() as unknown[]).length;
}

async function loadPrices(env: Env, f: typeof fetch, ids: string[]): Promise<PriceMap> {
  const map: PriceMap = new Map();
  try {
    const res = await f(
      `${env.supabaseUrl}/rest/v1/prices?select=product_id,price,currency&product_id=in.(${ids.join(",")})`,
      { headers: restHeaders(env) },
    );
    if (!res.ok) return map;
    (await res.json() as { product_id: string; price: number; currency: string }[])
      .forEach((r) => map.set(r.product_id, { price: r.price, currency: r.currency }));
  } catch (err) {
    console.error("price lookup failed", err);
  }
  return map;
}

async function notify(env: Env, f: typeof fetch, ref: string, q: QuoteInput, text: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const jobs: Promise<void>[] = [];
  if (env.callmebotPhone && env.callmebotApiKey) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(env.callmebotPhone)}` +
      `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.callmebotApiKey)}`;
    jobs.push(f(url, { signal: AbortSignal.timeout(8000) })
      .then((r) => { out.whatsapp = r.ok ? "sent" : `error ${r.status}`; })
      .catch((e) => { out.whatsapp = "error"; console.error("callmebot", e); }));
  }
  if (env.resendApiKey && env.adminEmail) {
    const html = `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
    jobs.push(f("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.resendFrom || "Luxoria <onboarding@resend.dev>",
        to: [env.adminEmail],
        subject: `New ${q.requestType} request ${ref} — ${q.name}`,
        html,
        text,
        ...(q.email ? { reply_to: q.email } : {}),
      }),
    })
      .then((r) => { out.email = r.ok ? "sent" : `error ${r.status}`; })
      .catch((e) => { out.email = "error"; console.error("resend", e); }));
  }
  await Promise.all(jobs);
  return out;
}

async function parseInput(req: Request): Promise<QuoteInput> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new ValidationError("Request too large.");
  try {
    return validate(JSON.parse(raw));
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Invalid request.");
  }
}

export function createHandler(env: Env, f: typeof fetch = fetch, now: () => number = Date.now) {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(env, req.headers.get("origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json(405, { error: "Method not allowed." }, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json(403, { error: "Origin not allowed." }, cors);

    let input: QuoteInput;
    try {
      input = await parseInput(req);
    } catch (err) {
      return json(400, { error: err instanceof ValidationError ? err.message : "Invalid request." }, cors);
    }

    try {
      const t = now();
      const ipHash = await sha256Hex(`${env.ipSalt}:${clientIp(req)}`);
      if (await recentCount(env, f, ipHash, new Date(t - RATE_WINDOW_MS).toISOString()) >= RATE_MAX) {
        return json(429, { error: "Too many requests. Please try again in a few minutes." }, cors);
      }

      const items = await loadItems(env, f, t, input.items);
      if (!items.length) return json(400, { error: "These fabrics are no longer available." }, cors);

      const ref = makeRef();
      const insert = await f(`${env.supabaseUrl}/rest/v1/quotes`, {
        method: "POST",
        headers: { ...restHeaders(env), Prefer: "return=minimal" },
        body: JSON.stringify({
          ref, channel: input.channel, request_type: input.requestType, client_name: input.name,
          client_whatsapp: input.whatsapp, client_email: input.email, message: input.message,
          items, ip_hash: ipHash,
        }),
      });
      if (!insert.ok) throw new Error(`insert failed: ${insert.status} ${await insert.text()}`);

      const prices = await loadPrices(env, f, items.map((p) => p.id));
      const notified = await notify(env, f, ref, input, buildAlertText(ref, input, items, prices, env.siteUrl));
      await f(`${env.supabaseUrl}/rest/v1/quotes?ref=eq.${ref}`, {
        method: "PATCH",
        headers: { ...restHeaders(env), Prefer: "return=minimal" },
        body: JSON.stringify({ notified }),
      }).catch((e) => console.error("notified update failed", e));

      return json(200, { ok: true, ref }, cors);
    } catch (err) {
      console.error("submit-quote failed", err);
      return json(500, { error: "We could not send your request. Please try WhatsApp or email instead." }, cors);
    }
  };
}

export function readEnv(get: (k: string) => string | undefined): Env {
  const required = (k: string, v: string | undefined) => {
    if (!v) throw new Error(`Missing required secret ${k}`);
    return v;
  };
  return {
    supabaseUrl: required("SUPABASE_URL", get("SUPABASE_URL")),
    serviceKey: required("SERVICE_KEY", get("SERVICE_KEY") ?? get("SUPABASE_SERVICE_ROLE_KEY")),
    allowedOrigins: (get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    siteUrl: required("SITE_URL", get("SITE_URL")),
    ipSalt: required("IP_SALT", get("IP_SALT")),
    callmebotPhone: get("CALLMEBOT_PHONE"),
    callmebotApiKey: get("CALLMEBOT_APIKEY"),
    resendApiKey: get("RESEND_API_KEY"),
    adminEmail: get("ADMIN_EMAIL"),
    resendFrom: get("RESEND_FROM"),
  };
}
