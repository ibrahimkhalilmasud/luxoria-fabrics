// Admin area: email + password, then a mandatory authenticator code (MFA, aal2).
// Security is enforced by Supabase Row Level Security, not by this page: without an
// aal2 session from a user listed in public.admins the database returns nothing.

const CFG = window.LUXORIA_CONFIG || {};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const IDLE_MS = 30 * 60 * 1000;
const POLL_MS = 60 * 1000;
const MAX_LOGIN_TRIES = 5;
const LOCKOUT_MS = 60 * 1000;
const MAX_PRICE = 1e9;
const DEFAULT_CURRENCY = /^[A-Z]{3}$/.test(CFG.currency || "") ? CFG.currency : "EUR";
const STATUSES = ["new", "contacted", "quoted", "won", "closed"];
const QUOTE_COLS = "id,ref,created_at,channel,request_type,client_name,client_whatsapp,client_email,message,items,status,admin_note";
const GATES = ["gateLogin", "gateMfa", "gateMsg", "paneQuotes", "panePrices"];

const state = {
  catalog: new Map(),
  quotes: [],
  prices: new Map(),
  edits: new Map(),
  qStatus: "",
  qSearch: "",
  selected: null,
  factorId: null,
  tab: "quotes",
  loginFails: 0,
  lockedUntil: 0,
};

// ---------------------------------------------------------------- boot
if (window.top !== window.self) {
  document.body.textContent = "This page cannot be shown inside a frame.";
  throw new Error("framed");
}

const sb = createClientOrNull();
if (!sb) {
  message("Backend not configured", "Add supabaseUrl and supabaseKey to assets/js/config.js, then reload.");
} else {
  bindUi();
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") show("gateLogin"); });
  route();
}

function createClientOrNull() {
  const ok = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CFG.supabaseUrl || "") && CFG.supabaseKey;
  if (!ok || !window.supabase) return null;
  return window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    // sessionStorage: the session ends when the tab closes and is never shared with other tabs.
    auth: { storage: window.sessionStorage, storageKey: "luxoria.admin", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

// ---------------------------------------------------------------- routing
function show(id) {
  GATES.forEach((g) => { $(`#${g}`).hidden = g !== id; });
  const inApp = id === "paneQuotes" || id === "panePrices";
  $("#admTabs").hidden = !inApp;
  $("#signOut").hidden = id === "gateLogin" || id === "gateMsg";
}

function message(title, text) {
  $("#gateMsgTitle").textContent = title;
  $("#gateMsgText").textContent = text;
  show("gateMsg");
}

async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show("gateLogin");

  // Only listed admins may continue (this read is allowed for your own row only).
  const { data: row, error } = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
  if (error || !row) {
    await sb.auth.signOut();
    return message("Not authorised", "This account has no admin access.");
  }

  const { data: aal, error: aalErr } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalErr) return message("Sign-in error", "Please reload and try again.");
  if (aal.currentLevel !== "aal2") return startMfa();
  enterApp();
}

// ---------------------------------------------------------------- login + MFA
function bindUi() {
  $("#loginForm").addEventListener("submit", onLogin);
  $("#mfaForm").addEventListener("submit", onVerify);
  $("#mfaCancel").addEventListener("click", signOut);
  $("#signOut").addEventListener("click", signOut);
  $$("#admTabs [data-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  bindQuotes();
  bindPrices();
  ["pointerdown", "keydown", "scroll"].forEach((ev) => window.addEventListener(ev, resetIdle, { passive: true }));
  window.addEventListener("beforeunload", (e) => { if (state.edits.size) e.preventDefault(); });
}

function setStatus(el, text) {
  el.textContent = text || "";
  el.hidden = !text;
}

async function onLogin(e) {
  e.preventDefault();
  const status = $("#loginStatus");
  if (Date.now() < state.lockedUntil) return setStatus(status, "Too many attempts. Wait a minute and try again.");
  const email = $("#lEmail").value.trim();
  const password = $("#lPass").value;
  if (!email || !password) return setStatus(status, "Enter your email and password.");

  setBusy(e.submitter, true);
  const { error } = await sb.auth.signInWithPassword({ email, password });
  setBusy(e.submitter, false);
  $("#lPass").value = "";
  if (error) {
    state.loginFails += 1;
    if (state.loginFails >= MAX_LOGIN_TRIES) { state.lockedUntil = Date.now() + LOCKOUT_MS; state.loginFails = 0; }
    return setStatus(status, "Email or password is incorrect.");
  }
  state.loginFails = 0;
  setStatus(status, "");
  route();
}

async function startMfa() {
  show("gateMfa");
  setStatus($("#mfaStatus"), "");
  $("#mfaCode").value = "";
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) return setStatus($("#mfaStatus"), "Could not load your authenticator. Reload the page.");

  const verified = (data.totp || []).find((f) => f.status === "verified");
  if (verified) {
    state.factorId = verified.id;
    $("#mfaTitle").textContent = "Enter your code";
    $("#mfaEnrol").hidden = true;
  } else {
    // First sign-in: remove half-finished enrolments, then show a fresh QR code.
    const stale = (data.all || []).filter((f) => f.factor_type === "totp" && f.status !== "verified");
    for (const f of stale) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data: en, error: enErr } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Luxoria admin ${Date.now()}` });
    if (enErr) return setStatus($("#mfaStatus"), "Could not start two-step setup. Reload the page.");
    state.factorId = en.id;
    $("#mfaTitle").textContent = "Set up two-step verification";
    $("#mfaQr").src = en.totp.qr_code;
    $("#mfaSecret").textContent = en.totp.secret;
    $("#mfaEnrol").hidden = false;
  }
  $("#mfaCode").focus();
}

async function onVerify(e) {
  e.preventDefault();
  const code = $("#mfaCode").value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return setStatus($("#mfaStatus"), "Enter the 6-digit code from your app.");
  setBusy(e.submitter, true);
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: state.factorId, code });
  setBusy(e.submitter, false);
  if (error) return setStatus($("#mfaStatus"), "That code did not work. Wait for a new one and try again.");
  $("#mfaQr").removeAttribute("src");
  $("#mfaSecret").textContent = "";
  route();
}

async function signOut() {
  if (state.edits.size && !confirm("You have unsaved price changes. Sign out anyway?")) return;
  state.edits.clear();
  stopPolling();
  await sb.auth.signOut();
  state.quotes = [];
  state.prices = new Map();
  $("#qList").innerHTML = "";
  $("#qDetail").innerHTML = "";
  $("#pRows").innerHTML = "";
  show("gateLogin");
}

let idleTimer = 0;
function resetIdle() {
  clearTimeout(idleTimer);
  if ($("#admTabs").hidden) return;
  idleTimer = setTimeout(() => { state.edits.clear(); signOut(); toast("Signed out after 30 minutes of inactivity."); }, IDLE_MS);
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle("is-busy", busy);
}

// ---------------------------------------------------------------- app
async function enterApp() {
  switchTab(state.tab);
  resetIdle();
  await Promise.all([loadCatalog(), loadPrices()]);
  await loadQuotes();
  renderPrices();
  startPolling();
}

function switchTab(tab) {
  state.tab = tab;
  $$("#admTabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  show(tab === "prices" ? "panePrices" : "paneQuotes");
}

async function loadCatalog() {
  try {
    const res = await fetch("../data/products.json", { cache: "no-cache" });
    const data = await res.json();
    state.catalog = new Map(data.products.map((p) => [p.id, p]));
  } catch {
    toast("Could not load the fabric catalogue.");
  }
  const cols = [...new Set([...state.catalog.values()].map((p) => p.collection))].sort();
  $("#pCollection").innerHTML = `<option value="">All collections</option>${cols.map((c) => `<option>${esc(c)}</option>`).join("")}`;
}

let pollTimer = 0;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (!document.hidden) loadQuotes({ quiet: true }); }, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); }

// ---------------------------------------------------------------- quotes
function bindQuotes() {
  $$("#qStatus [data-status]").forEach((b) => b.addEventListener("click", () => {
    state.qStatus = b.dataset.status;
    $$("#qStatus [data-status]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderQuotes();
  }));
  $("#qSearch").addEventListener("input", (e) => { state.qSearch = e.target.value.trim().toLowerCase(); renderQuotes(); });
  $("#qRefresh").addEventListener("click", () => loadQuotes());
  $("#qList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (btn) selectQuote(btn.dataset.id);
  });
}

async function loadQuotes({ quiet = false } = {}) {
  const { data, error } = await sb.from("quotes").select(QUOTE_COLS).order("created_at", { ascending: false }).limit(500);
  if (error) {
    if (!quiet) toast("Could not load quotes. Sign in again if this continues.");
    return;
  }
  const known = new Set(state.quotes.map((q) => q.id));
  const fresh = quiet && state.quotes.length ? data.filter((q) => !known.has(q.id)) : [];
  state.quotes = data;
  if (fresh.length) toast(`${fresh.length} new quote${fresh.length > 1 ? "s" : ""} received.`);
  renderQuotes();
  updateNewCount();
}

function updateNewCount() {
  const n = state.quotes.filter((q) => q.status === "new").length;
  const badge = $("#newCount");
  badge.textContent = String(n);
  badge.hidden = n === 0;
  document.title = n ? `(${n}) Admin — Luxoria` : "Admin — Luxoria";
}

function visibleQuotes() {
  return state.quotes.filter((q) => {
    if (state.qStatus && q.status !== state.qStatus) return false;
    if (!state.qSearch) return true;
    return [q.client_name, q.client_whatsapp, q.client_email, q.ref].join(" ").toLowerCase().includes(state.qSearch);
  });
}

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function renderQuotes() {
  const list = visibleQuotes();
  $("#qList").innerHTML = list.length
    ? list.map((q) => `
      <li><button class="q-row${q.id === state.selected ? " is-active" : ""}" data-id="${esc(q.id)}">
        <span class="q-row__top"><strong>${esc(q.client_name)}</strong><span class="pill pill--${esc(q.status)}">${esc(q.status)}</span></span>
        <span class="q-row__meta">${esc(q.ref)} · ${esc(q.request_type)} · ${q.items.length} item${q.items.length > 1 ? "s" : ""}</span>
        <span class="q-row__meta">${esc(fmtDate(q.created_at))} · via ${esc(q.channel)}</span>
      </button></li>`).join("")
    : `<li class="adm-empty">No quotes here yet.</li>`;
  if (state.selected) renderDetail(state.quotes.find((q) => q.id === state.selected));
}

function selectQuote(id) {
  state.selected = id;
  renderQuotes();
  if (window.matchMedia("(max-width: 900px)").matches) $("#qDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function itemView(item) {
  const p = state.catalog.get(item.id) || item;
  const price = state.prices.get(item.id);
  const title = [p.article, p.designNo].filter(Boolean).join(" · ") || item.id;
  const thumb = p.thumb ? `<img src="../${esc(p.thumb)}" alt="" loading="lazy" width="80" height="160">` : "";
  return `<li class="q-item">
    <a href="../index.html#fabric/${encodeURIComponent(item.id)}" target="_blank" rel="noopener noreferrer">${thumb}</a>
    <div><strong>${esc(title)}</strong>
      <span>${esc([p.category, p.composition, p.colourFamily].filter(Boolean).join(" · "))}</span>
      <span>${p.quantity != null ? `${esc(p.quantity)} m in stock` : ""}</span>
      <span class="q-item__price">${price ? `${esc(price.currency)} ${esc(Number(price.price).toFixed(2))} / m` : "No price set"}</span>
    </div></li>`;
}

function waLink(q) {
  const digits = String(q.client_whatsapp).replace(/\D/g, "");
  const text = `Hello ${q.client_name}, thank you for your Luxoria request ${q.ref}.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function renderDetail(q) {
  const box = $("#qDetail");
  if (!q) { box.innerHTML = `<p class="adm-empty">Select a quote to see the details.</p>`; return; }
  const mail = q.client_email ? `<a class="btn btn--line" href="mailto:${encodeURIComponent(q.client_email)}?subject=${encodeURIComponent(`Luxoria request ${q.ref}`)}">Email</a>` : "";
  box.innerHTML = `
    <div class="q-detail__head">
      <p class="eyebrow">${esc(q.ref)} · ${esc(fmtDate(q.created_at))}</p>
      <h2>${esc(q.client_name)}</h2>
      <p class="q-detail__contact">${esc(q.client_whatsapp)}${q.client_email ? ` · ${esc(q.client_email)}` : ""}</p>
      <div class="q-detail__actions">
        <a class="btn btn--gold" href="${esc(waLink(q))}" target="_blank" rel="noopener noreferrer">Reply on WhatsApp</a>${mail}
      </div>
    </div>
    <dl class="q-facts"><dt>Request</dt><dd>${esc(q.request_type)}</dd><dt>Sent via</dt><dd>${esc(q.channel)}</dd></dl>
    ${q.message ? `<blockquote class="q-msg">${esc(q.message)}</blockquote>` : ""}
    <h3>${q.items.length} fabric${q.items.length > 1 ? "s" : ""}</h3>
    <ul class="q-items">${q.items.map(itemView).join("")}</ul>
    <form class="q-edit" id="qEdit">
      <label class="field"><span>Status</span>
        <select id="qEditStatus">${STATUSES.map((s) => `<option value="${s}"${s === q.status ? " selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span>Private note</span>
        <textarea id="qEditNote" rows="3" maxlength="2000">${esc(q.admin_note || "")}</textarea></label>
      <div class="q-edit__actions">
        <button class="btn btn--gold" type="submit">Save</button>
        <button class="link q-delete" type="button" id="qDelete">Delete quote</button>
      </div>
    </form>`;
  $("#qEdit").addEventListener("submit", (e) => { e.preventDefault(); saveQuote(q.id, e.submitter); });
  $("#qDelete").addEventListener("click", () => deleteQuote(q));
}

async function saveQuote(id, btn) {
  const status = $("#qEditStatus").value;
  const note = $("#qEditNote").value.trim().slice(0, 2000);
  if (!STATUSES.includes(status)) return;
  setBusy(btn, true);
  const { error } = await sb.from("quotes").update({ status, admin_note: note || null }).eq("id", id);
  setBusy(btn, false);
  if (error) return toast("Could not save. Please try again.");
  state.quotes = state.quotes.map((q) => (q.id === id ? { ...q, status, admin_note: note || null } : q));
  renderQuotes();
  updateNewCount();
  toast("Saved.");
}

async function deleteQuote(q) {
  if (!confirm(`Delete quote ${q.ref} from ${q.client_name}? This cannot be undone.`)) return;
  const { error } = await sb.from("quotes").delete().eq("id", q.id);
  if (error) return toast("Could not delete. Please try again.");
  state.quotes = state.quotes.filter((x) => x.id !== q.id);
  state.selected = null;
  renderQuotes();
  updateNewCount();
  toast("Quote deleted.");
}

// ---------------------------------------------------------------- prices
function bindPrices() {
  ["#pCollection", "#pSearch", "#pMissing"].forEach((s) => $(s).addEventListener("input", renderPrices));
  $("#pRows").addEventListener("input", onPriceInput);
  $("#pBulkApply").addEventListener("click", applyBulk);
  $("#pSave").addEventListener("click", savePrices);
}

async function loadPrices() {
  const { data, error } = await sb.from("prices").select("product_id,price,currency");
  if (error) return toast("Could not load prices.");
  state.prices = new Map(data.map((r) => [r.product_id, { price: r.price, currency: r.currency }]));
}

function visibleProducts() {
  const col = $("#pCollection").value;
  const q = $("#pSearch").value.trim().toLowerCase();
  const missing = $("#pMissing").checked;
  return [...state.catalog.values()].filter((p) => {
    if (col && p.collection !== col) return false;
    if (missing && state.prices.has(p.id)) return false;
    return !q || [p.article, p.designNo, p.composition, p.colourFamily, p.id].join(" ").toLowerCase().includes(q);
  });
}

function currentPrice(id) {
  const edit = state.edits.get(id);
  const saved = state.prices.get(id);
  return {
    price: edit ? edit.price : saved ? String(saved.price) : "",
    currency: edit ? edit.currency : saved ? saved.currency : DEFAULT_CURRENCY,
  };
}

function renderPrices() {
  const rows = visibleProducts();
  $("#pInfo").textContent = `${rows.length} fabrics shown · ${state.prices.size} of ${state.catalog.size} priced · prices are private and never shown on the public site.`;
  $("#pRows").innerHTML = rows.map((p) => {
    const cur = currentPrice(p.id);
    return `<tr data-id="${esc(p.id)}"${state.edits.has(p.id) ? ' class="is-dirty"' : ""}>
      <td><img src="../${esc(p.thumb)}" alt="" loading="lazy" width="36" height="72"></td>
      <td><strong>${esc(p.article)}</strong><span>${esc(p.designNo)}</span></td>
      <td>${esc([p.category, p.composition, p.colourFamily].filter(Boolean).join(" · "))}</td>
      <td>${p.quantity != null ? esc(p.quantity) : "—"}</td>
      <td><input type="number" min="0" step="0.01" inputmode="decimal" data-field="price" value="${esc(cur.price)}" aria-label="Price per metre for ${esc(p.article)}"></td>
      <td><input type="text" maxlength="3" data-field="currency" value="${esc(cur.currency)}" aria-label="Currency"></td>
    </tr>`;
  }).join("");
  updateSaveButton();
}

function onPriceInput(e) {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const price = $('[data-field="price"]', row).value.trim();
  const currency = $('[data-field="currency"]', row).value.trim().toUpperCase();
  const saved = state.prices.get(id);
  const unchanged = saved ? String(saved.price) === price && saved.currency === currency : price === "";
  if (unchanged) state.edits.delete(id); else state.edits.set(id, { price, currency });
  row.classList.toggle("is-dirty", !unchanged);
  updateSaveButton();
}

function applyBulk() {
  const value = $("#pBulk").value.trim();
  if (!isValidPrice(value)) return toast("Enter a valid price first.");
  const rows = visibleProducts();
  if (!confirm(`Set ${value} per metre on all ${rows.length} fabrics shown? You can review before saving.`)) return;
  rows.forEach((p) => state.edits.set(p.id, { price: value, currency: currentPrice(p.id).currency }));
  renderPrices();
}

const isValidPrice = (v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= MAX_PRICE;

function updateSaveButton() {
  const n = state.edits.size;
  const btn = $("#pSave");
  btn.disabled = n === 0;
  btn.textContent = n ? `Save ${n} change${n > 1 ? "s" : ""}` : "Save changes";
}

async function savePrices() {
  const upserts = [];
  const removals = [];
  for (const [id, { price, currency }] of state.edits) {
    if (price === "") { removals.push(id); continue; }
    if (!isValidPrice(price) || !/^[A-Z]{3}$/.test(currency)) {
      return toast(`Check the price for ${state.catalog.get(id)?.article || id}: use numbers like 45 or 45.50 and a 3-letter currency.`);
    }
    upserts.push({ product_id: id, price: Number(price), currency });
  }
  const btn = $("#pSave");
  setBusy(btn, true);
  const results = await Promise.all([
    upserts.length ? sb.from("prices").upsert(upserts, { onConflict: "product_id" }) : { error: null },
    removals.length ? sb.from("prices").delete().in("product_id", removals) : { error: null },
  ]);
  setBusy(btn, false);
  if (results.some((r) => r.error)) return toast("Some prices could not be saved. Please try again.");
  const n = upserts.length + removals.length;
  state.edits.clear();
  await loadPrices();
  renderPrices();
  if (state.selected) renderQuotes();
  toast(`Saved ${n} price${n > 1 ? "s" : ""}.`);
}

// ---------------------------------------------------------------- toast
let toastTimer = 0;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 3600);
}
