/* Cart page: review the selection, open any piece full screen, and send it by
   quotation request (backend), WhatsApp or email. */
import { $, cart, CFG, esc, initHeader, lazyImages, loadCatalog, mailHref, productUrl, qtyText, seriesText, storage, titleOf, toast, whatsappHref } from "./core.js";
import { openViewer } from "./viewer.js";

const STORE_CLIENT = "luxoria.client";
const FN_TIMEOUT_MS = 20000;
let byId = new Map();

const items = () => cart.ids().map((id) => byId.get(id)).filter(Boolean);

function render() {
  const list = items();
  $("#cartTitleCount").textContent = list.length ? `${list.length} piece${list.length === 1 ? "" : "s"}` : "";
  $("#cartEmpty").hidden = list.length > 0;
  $("#cartLayout").hidden = list.length === 0;
  const metres = list.reduce((s, p) => s + (p.quantity || 0), 0);
  $("#cartSummary").textContent = `${list.length} piece${list.length === 1 ? "" : "s"} · ${Math.round(metres * 10) / 10} m in stock`;

  const tpl = document.createElement("template");
  tpl.innerHTML = list.map((p, i) => `<li class="cart-item">
    <button class="cart-item__media" data-open="${i}" aria-label="View ${esc(titleOf(p))} full screen">
      <img data-src="${esc(p.thumb)}" alt="${esc(titleOf(p))}" width="${p.w}" height="${p.h}">
    </button>
    <div class="cart-item__body">
      <strong>${esc(titleOf(p))}</strong>
      <span>${esc([p.category, p.composition].filter(Boolean).join(" · "))}</span>
      <span>${esc([seriesText(p), `${qtyText(p.quantity)} available`].filter(Boolean).join(" · "))}</span>
      <button class="link" data-open="${i}">View details</button>
    </div>
    <button class="cart-item__remove" data-remove="${esc(p.id)}" aria-label="Remove ${esc(titleOf(p))} from cart">✕</button>
  </li>`).join("");
  lazyImages(tpl.content);
  $("#cartList").replaceChildren(tpl.content);
}

/* ---------- Form ---------- */
function readForm() {
  return {
    name: $("#fName").value.replace(/\s+/g, " ").trim(),
    whatsapp: $("#fWhatsapp").value.trim(),
    email: $("#fEmail").value.trim(),
    requestType: $("#fType").value,
    message: $("#fMessage").value.trim(),
    website: $("#fWebsite").value,
  };
}

function normaliseWhatsapp(v) {
  let n = v.replace(/[\s().-]/g, "");
  if (n.startsWith("00")) n = "+" + n.slice(2);
  if (!n.startsWith("+")) n = "+" + n;
  return /^\+[0-9]{7,15}$/.test(n) ? n : null;
}

function validateForm(f) {
  const errors = {};
  if (f.name.length < 2 || f.name.length > 80) errors.fName = "Please enter your name.";
  if (!normaliseWhatsapp(f.whatsapp)) errors.fWhatsapp = "Enter your WhatsApp number with country code, e.g. +971 50 123 4567.";
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) errors.fEmail = "Please enter a valid email, or leave it empty.";
  if (f.message.length > 1000) errors.fMessage = "Please keep the message under 1000 characters.";
  ["fName", "fWhatsapp", "fEmail", "fMessage"].forEach((id) => {
    const field = $(`#${id}`).closest(".field");
    field.classList.toggle("has-error", !!errors[id]);
    field.querySelector(".field__error").textContent = errors[id] || "";
    $(`#${id}`).setAttribute("aria-invalid", String(!!errors[id]));
  });
  const first = Object.keys(errors)[0];
  if (first) $(`#${first}`).focus();
  return !first;
}

function messageText(f, list) {
  const lines = [
    `Hello ${CFG.brand},`,
    "",
    `I would like to request: ${f.requestType}, for these ${list.length} fabric${list.length === 1 ? "" : "s"}:`,
    "",
    ...list.flatMap((p, i) => [
      `${i + 1}. ${titleOf(p)} — ${[p.category, p.composition, seriesText(p), `${qtyText(p.quantity)} available`].filter(Boolean).join(" · ")}`,
      `   ${productUrl(p.id)}`,
    ]),
    "",
    `Name: ${f.name}`,
    `WhatsApp: ${normaliseWhatsapp(f.whatsapp)}`,
  ];
  if (f.email) lines.push(`Email: ${f.email}`);
  if (f.message) lines.push("", f.message);
  return lines.join("\n");
}

const backendReady = () => /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CFG.supabaseUrl || "") && !!CFG.supabaseKey;

function submitToBackend(channel, f, list, { keepalive = false } = {}) {
  const headers = { "Content-Type": "application/json", apikey: CFG.supabaseKey };
  if (CFG.supabaseKey.startsWith("ey")) headers.Authorization = `Bearer ${CFG.supabaseKey}`;
  return fetch(`${CFG.supabaseUrl}/functions/v1/submit-quote`, {
    method: "POST",
    headers,
    keepalive,
    signal: keepalive ? undefined : AbortSignal.timeout(FN_TIMEOUT_MS),
    body: JSON.stringify({
      channel, requestType: f.requestType, name: f.name, whatsapp: normaliseWhatsapp(f.whatsapp),
      email: f.email || null, message: f.message || null, items: list.map((p) => p.id), website: f.website,
    }),
  });
}

function remember(f) {
  storage.set(STORE_CLIENT, { name: f.name, whatsapp: f.whatsapp, email: f.email });
}

function setBusy(busy) {
  ["#sendQuote", "#sendWhatsapp", "#sendEmail"].forEach((s) => { $(s).disabled = busy; });
  $("#sendQuote").classList.toggle("is-busy", busy);
}

async function sendQuotation() {
  const f = readForm();
  const list = items();
  if (!list.length || !validateForm(f)) return;
  remember(f);
  if (!backendReady()) {
    if (CFG.whatsapp) {
      toast("Online quotations are not switched on yet — opening WhatsApp instead.");
      window.open(whatsappHref(messageText(f, list)), "_blank", "noopener");
    } else {
      $("#formStatus").textContent = "Online quotations open shortly. Your selection is saved on this device — please come back soon.";
      $("#formStatus").hidden = false;
    }
    return;
  }
  setBusy(true);
  try {
    const res = await submitToBackend("quotation", f, list);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "We could not send your request.");
    showSuccess(data.ref, f);
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "The connection timed out. Please try again or use WhatsApp." : err.message;
    $("#formStatus").textContent = msg;
    $("#formStatus").hidden = false;
  } finally {
    setBusy(false);
  }
}

/** WhatsApp / email open immediately (so pop-up blockers allow them); the backend copy is best effort. */
function sendDirect(channel) {
  const f = readForm();
  const list = items();
  if (!list.length || !validateForm(f)) return;
  remember(f);
  const text = messageText(f, list);
  if (channel === "whatsapp") window.open(whatsappHref(text), "_blank", "noopener");
  else location.href = mailHref(`${f.requestType} request — ${list.length} fabric${list.length === 1 ? "" : "s"} — ${f.name}`, text);
  if (backendReady()) submitToBackend(channel, f, list, { keepalive: true }).catch(() => { /* direct message already sent */ });
}

function showSuccess(ref, f) {
  $("#cartLayout").hidden = true;
  $("#cartDone").hidden = false;
  $("#doneRef").textContent = ref;
  $("#doneContact").textContent = normaliseWhatsapp(f.whatsapp);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bind() {
  $("#cartList").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      const p = byId.get(rm.dataset.remove);
      cart.remove(rm.dataset.remove);
      if (p) toast(`${titleOf(p)} removed`);
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openViewer(items(), Number(open.dataset.open));
  });
  cart.onChange(render);
  $("#cartForm").addEventListener("submit", (e) => { e.preventDefault(); sendQuotation(); });
  $("#sendWhatsapp").addEventListener("click", () => sendDirect("whatsapp"));
  $("#sendEmail").addEventListener("click", () => sendDirect("email"));
  $("#clearCart").addEventListener("click", () => {
    if (confirm("Remove every fabric from your cart?")) cart.clear();
  });
  $("#doneNew").addEventListener("click", () => {
    cart.clear();
    $("#cartDone").hidden = true;
    render();
  });
  $("#fMessage").addEventListener("input", (e) => { $("#msgCount").textContent = `${e.target.value.length} / 1000`; });

  const saved = storage.get(STORE_CLIENT, {});
  $("#fName").value = saved.name || "";
  $("#fWhatsapp").value = saved.whatsapp || "";
  $("#fEmail").value = saved.email || "";
  $("#sendWhatsapp").hidden = !CFG.whatsapp;
  $("#sendEmail").hidden = !CFG.email;
}

async function init() {
  initHeader();
  try {
    const data = await loadCatalog();
    byId = data.byId;
    cart.prune(byId);
  } catch (err) {
    $("#cartEmpty").hidden = false;
    $("#cartEmpty").querySelector("p").textContent = "Your cart could not be loaded. Please refresh the page.";
    throw err;
  }
  bind();
  render();
}

init();
