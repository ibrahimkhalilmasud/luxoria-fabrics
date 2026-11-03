import { buildAlertText, createHandler, type Env, escapeHtml, makeRef, normaliseWhatsapp, resetCatalogCache, validate, ValidationError } from "./handler.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`expected ${y}, got ${x}`);
};
const assertThrows = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
  } catch (e) {
    assert(e instanceof ValidationError, `wrong error type: ${e}`);
    assert(re.test((e as Error).message), `message "${(e as Error).message}" !~ ${re}`);
    return;
  }
  throw new Error("expected throw");
};

const ORIGIN = "https://shop.example.com";
const env: Env = {
  supabaseUrl: "https://db.example.co",
  serviceKey: "sb_secret_test",
  allowedOrigins: [ORIGIN],
  siteUrl: "https://shop.example.com",
  ipSalt: "salt",
  callmebotPhone: "+971500000000",
  callmebotApiKey: "cmb",
  resendApiKey: "re_test",
  adminEmail: "owner@example.com",
};

const good = {
  channel: "quotation",
  requestType: "Swatches",
  name: "  Amira   Haddad ",
  whatsapp: "00971 50-123 4567",
  email: "amira@example.com",
  message: "Need 3 m each",
  items: ["cemb-1", "cemb-2", "cemb-1"],
  website: "",
};

const catalog = {
  products: [
    { id: "cemb-1", article: "CEMB 1", designNo: "60-SC", quantity: 7, collection: "CEMB", category: "Lace" },
    { id: "cemb-2", article: "CEMB 2", designNo: "60-SC", quantity: 5, collection: "CEMB", category: "Lace" },
  ],
};

interface Call { url: string; init?: RequestInit }

function mockFetch(opts: { recent?: number; insertStatus?: number; edits?: unknown[] } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/data/products.json")) return Response.json(catalog);
    if (url.includes("/rest/v1/quotes?select=id")) return Response.json(Array(opts.recent ?? 0).fill({ id: "x" }));
    if (url.includes("/rest/v1/product_edits")) return Response.json(opts.edits ?? []);
    if (url.includes("/rest/v1/prices")) return Response.json([{ product_id: "cemb-1", price: 42.5, currency: "EUR" }]);
    if (url.endsWith("/rest/v1/quotes") && init?.method === "POST") return new Response(null, { status: opts.insertStatus ?? 201 });
    if (url.includes("/rest/v1/quotes?ref=eq.")) return new Response(null, { status: 204 });
    if (url.startsWith("https://api.callmebot.com/")) return new Response("ok");
    if (url === "https://api.resend.com/emails") return Response.json({ id: "1" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const post = (body: unknown, origin = ORIGIN) =>
  new Request("https://fn.example.co/submit-quote", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("validate normalises and deduplicates input", () => {
  const q = validate(good);
  assertEquals(q.name, "Amira Haddad");
  assertEquals(q.whatsapp, "+971501234567");
  assertEquals(q.items, ["cemb-1", "cemb-2"]);
  assertEquals(q.email, "amira@example.com");
});

Deno.test("validate rejects bad fields", () => {
  assertThrows(() => validate({ ...good, website: "spam" }), /Invalid request/);
  assertThrows(() => validate({ ...good, channel: "sms" }), /channel/);
  assertThrows(() => validate({ ...good, requestType: "Free stuff" }), /request type/);
  assertThrows(() => validate({ ...good, name: "A" }), /name/);
  assertThrows(() => validate({ ...good, name: "x".repeat(81) }), /name/);
  assertThrows(() => validate({ ...good, whatsapp: "12ab" }), /WhatsApp/);
  assertThrows(() => validate({ ...good, email: "not-an-email" }), /email/);
  assertThrows(() => validate({ ...good, message: "x".repeat(1001) }), /too long/);
  assertThrows(() => validate({ ...good, items: [] }), /empty/);
  assertThrows(() => validate({ ...good, items: ["../etc/passwd", "<script>"] }), /empty/);
  assertThrows(() => validate({ ...good, items: Array(201).fill("cemb-1") }), /Too many/);
  assertThrows(() => validate([good]), /Invalid request/);
});

Deno.test("normaliseWhatsapp handles common formats", () => {
  assertEquals(normaliseWhatsapp("+44 (0) 7700 900123"), "+4407700900123");
  assertEquals(normaliseWhatsapp("971501234567"), "+971501234567");
  assertEquals(normaliseWhatsapp("123"), null);
  assertEquals(normaliseWhatsapp(42), null);
});

Deno.test("makeRef uses the unambiguous alphabet", () => {
  const ref = makeRef();
  assert(/^[A-HJ-NP-Z2-9]{8}$/.test(ref), ref);
});

Deno.test("escapeHtml neutralises markup", () => {
  assertEquals(escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
});

Deno.test("alert text includes items, prices and admin link", () => {
  const text = buildAlertText("ABCD2345", validate(good), catalog.products, new Map([["cemb-1", { price: 42.5, currency: "EUR" }]]), "https://shop.example.com/");
  assert(text.includes("CEMB 1 · 60-SC · 7 m · EUR 42.50/m"));
  assert(text.includes("+971501234567"));
  assert(text.includes("https://shop.example.com/admin/"));
});

Deno.test("rejects foreign origins and non-POST", async () => {
  const { f, calls } = mockFetch();
  const h = createHandler(env, f);
  assertEquals((await h(post(good, "https://evil.example"))).status, 403);
  assertEquals((await h(new Request("https://fn/x", { method: "GET", headers: { origin: ORIGIN } }))).status, 405);
  const pre = await h(new Request("https://fn/x", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assertEquals(calls.length, 0);
});

Deno.test("rejects malformed and oversized bodies without touching the database", async () => {
  const { f, calls } = mockFetch();
  const h = createHandler(env, f);
  assertEquals((await h(post("{not json"))).status, 400);
  assertEquals((await h(post({ ...good, message: "x".repeat(25_000) }))).status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("rate limits repeat submissions", async () => {
  resetCatalogCache();
  const { f, calls } = mockFetch({ recent: 5 });
  const res = await createHandler(env, f)(post(good));
  assertEquals(res.status, 429);
  assert(!calls.some((c) => c.init?.method === "POST"), "must not insert");
});

Deno.test("stores the quote and alerts the owner", async () => {
  resetCatalogCache();
  const { f, calls } = mockFetch();
  const res = await createHandler(env, f)(post(good));
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.ok && /^[A-Z0-9]{8}$/.test(body.ref));

  const insert = calls.find((c) => c.url.endsWith("/rest/v1/quotes") && c.init?.method === "POST")!;
  const row = JSON.parse(String(insert.init!.body));
  assertEquals(row.client_whatsapp, "+971501234567");
  assertEquals(row.items.map((i: { article: string }) => i.article), ["CEMB 1", "CEMB 2"]);
  assert(/^[0-9a-f]{64}$/.test(row.ip_hash), "ip must be hashed");
  assert(!JSON.stringify(row).includes("203.0.113.9"), "raw IP must not be stored");
  assertEquals((insert.init!.headers as Record<string, string>).apikey, "sb_secret_test");

  const wa = calls.find((c) => c.url.startsWith("https://api.callmebot.com/"))!;
  assert(decodeURIComponent(wa.url).includes("EUR 42.50/m"));
  const mail = JSON.parse(String(calls.find((c) => c.url === "https://api.resend.com/emails")!.init!.body));
  assertEquals(mail.to, ["owner@example.com"]);
  assertEquals(mail.reply_to, "amira@example.com");
});

Deno.test("drops unknown product ids and refuses an all-unknown cart", async () => {
  resetCatalogCache();
  const { f } = mockFetch();
  const res = await createHandler(env, f)(post({ ...good, items: ["cemb-999"] }));
  assertEquals(res.status, 400);
});

Deno.test("database failure returns a generic error", async () => {
  resetCatalogCache();
  const { f } = mockFetch({ insertStatus: 500 });
  const res = await createHandler(env, f)(post(good));
  assertEquals(res.status, 500);
  const body = await res.json();
  assert(!JSON.stringify(body).includes("insert failed"), "must not leak internals");
});

Deno.test("uses admin edits and leaves out hidden fabrics", async () => {
  resetCatalogCache();
  const edits = [
    { product_id: "cemb-1", article: "CEMB 1", name: "Rose Garden", design_no: "D-77", quantity: "12.5", category: "Lace", colour_family: "Pink", status: "available" },
    { product_id: "cemb-2", article: "CEMB 2", name: null, design_no: null, quantity: null, category: "Lace", colour_family: "Red", status: "hidden" },
  ];
  const { f, calls } = mockFetch({ edits });
  const res = await createHandler(env, f)(post(good));
  assertEquals(res.status, 200);
  const row = JSON.parse(String(calls.find((c) => c.url.endsWith("/rest/v1/quotes") && c.init?.method === "POST")!.init!.body));
  assertEquals(row.items.length, 1);
  assertEquals(row.items[0].designNo, "D-77");
  assertEquals(row.items[0].quantity, 12.5);
  const wa = decodeURIComponent(calls.find((c) => c.url.startsWith("https://api.callmebot.com/"))!.url);
  assert(wa.includes("Rose Garden (CEMB 1) · D-77 · 12.5 m"));
});
