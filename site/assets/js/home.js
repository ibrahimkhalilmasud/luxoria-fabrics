/* Home page: hero showcase + filterable collection grid. */
import { $, $$, byCategory, cart, categoryRank, CFG, esc, ICON_PLUS, initHeader, initReveal, lazyImages, loadCatalog, lockScroll, mailHref, qtyText, seriesText, storage, syncCartButtons, titleOf, toggleCart, whatsappHref } from "./core.js";
import { openViewer } from "./viewer.js";

const STORE_DENSITY = "luxoria.density";
const FACETS = [
  // [state key, product field, container, group (hidden when < 2 values)]
  ["categories", "category", "#fCategory", "#fCategoryGroup"],
  ["collections", "collection", "#fCollection", "#fCollectionGroup"],
  ["qualities", "composition", "#fQuality", "#fQualityGroup"],
  ["designs", "designNo", "#fDesign", "#fDesignGroup"],
];

const emptyFilters = () => ({
  q: "", colours: new Set(), categories: new Set(), collections: new Set(), qualities: new Set(), designs: new Set(),
  minQty: 0, available: false, inCart: false,
});

const state = { products: [], families: {}, filters: emptyFilters(), sort: "featured", results: [], shown: 0 };

/* ---------- URL state ---------- */
const URL_SETS = { colour: "colours", category: "categories", collection: "collections", quality: "qualities", design: "designs" };

function readUrl() {
  const params = new URLSearchParams(location.search);
  const f = state.filters;
  Object.entries(URL_SETS).forEach(([k, key]) => { f[key] = new Set((params.get(k) || "").split(",").filter(Boolean)); });
  f.q = params.get("q") || "";
  f.minQty = Number(params.get("min")) || 0;
  f.available = params.get("stock") === "1";
  f.inCart = params.get("cart") === "1";
  state.sort = params.get("sort") || "featured";
}

function writeUrl() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  Object.entries(URL_SETS).forEach(([k, key]) => { if (f[key].size) params.set(k, [...f[key]].join(",")); });
  if (f.minQty) params.set("min", f.minQty);
  if (f.available) params.set("stock", "1");
  if (f.inCart) params.set("cart", "1");
  if (state.sort !== "featured") params.set("sort", state.sort);
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? "?" + qs : ""}${location.hash}`);
}

/* ---------- Filtering ---------- */
function matches(p, f, skip) {
  if (f.q && !f.q.toLowerCase().split(/\s+/).every((t) => p._search.includes(t))) return false;
  if (skip !== "colours" && f.colours.size && !f.colours.has(p.colourFamily)) return false;
  for (const [key, field] of FACETS) {
    if (skip !== key && f[key].size && !f[key].has(p[field])) return false;
  }
  if (f.minQty && !(p.quantity >= f.minQty)) return false;
  if (f.available && p.status !== "available") return false;
  if (f.inCart && !cart.has(p.id)) return false;
  return true;
}

const SORTS = {
  // Silk, then embroidery, then lace; within each family signature pieces, then the
  // best photographs (grade 1-3), each grade in serial-number order.
  featured: (a, b) => (categoryRank(a.category) - categoryRank(b.category)) || (b.featured - a.featured)
    || ((a.grade || 2) - (b.grade || 2)) || (a._order - b._order),
  article: (a, b) => a._order - b._order,
  "article-desc": (a, b) => b._order - a._order,
  "qty-desc": (a, b) => (b.quantity ?? -1) - (a.quantity ?? -1),
  "qty-asc": (a, b) => (a.quantity ?? 1e9) - (b.quantity ?? 1e9),
};

function apply() {
  state.results = state.products.filter((p) => matches(p, state.filters)).sort(SORTS[state.sort] || SORTS.featured);
  state.shown = 0;
  $("#grid").replaceChildren();
  renderMore();
  renderFacets();
  renderActiveChips();
  const n = state.results.length;
  const total = state.products.length;
  $("#resultCount").innerHTML = n === total ? `<strong>${total}</strong> pieces in the archive` : `<strong>${n}</strong> of ${total} pieces`;
  $("#empty").hidden = n > 0;
  writeUrl();
}

/* ---------- Facets ---------- */
function countBy(field, skip) {
  const counts = new Map();
  state.products.forEach((p) => {
    if (p[field] && matches(p, state.filters, skip)) counts.set(p[field], (counts.get(p[field]) || 0) + 1);
  });
  return counts;
}

function renderFacets() {
  const f = state.filters;
  const colourCounts = countBy("colourFamily", "colours");
  $("#fColour").innerHTML = Object.entries(state.families)
    .filter(([name]) => state.products.some((p) => p.colourFamily === name))
    .map(([name, hex]) => {
      const n = colourCounts.get(name) || 0;
      const on = f.colours.has(name);
      return `<button class="swatch" data-facet="colours" data-value="${esc(name)}" aria-pressed="${on}"
        ${!n && !on ? "disabled" : ""}><i style="--c:${esc(hex)}" aria-hidden="true"></i>${esc(name)}<small>${n}</small></button>`;
    }).join("");

  FACETS.forEach(([key, field, sel, group]) => {
    const values = [...new Set(state.products.map((p) => p[field]).filter(Boolean))]
      .sort(key === "categories" ? byCategory : (a, b) => a.localeCompare(b, undefined, { numeric: true }));
    $(group).hidden = values.length < 2;
    const counts = countBy(field, key);
    $(sel).innerHTML = values.map((v) => {
      const on = f[key].has(v);
      const n = counts.get(v) || 0;
      return `<button class="chip" data-facet="${key}" data-value="${esc(v)}" aria-pressed="${on}" ${!n && !on ? "disabled" : ""}>${esc(v)}<small>${n}</small></button>`;
    }).join("");
  });

  const maxQty = Math.ceil(Math.max(1, ...state.products.map((p) => p.quantity || 0)));
  $("#fQty").max = maxQty;
  $("#fQty").value = f.minQty;
  $("#fQtyMax").textContent = `${maxQty} m`;
  $("#fQtyOut").textContent = f.minQty ? `${f.minQty}+ m` : "Any";
  $("#fAvailable").checked = f.available;
  $("#fInCart").checked = f.inCart;
  const active = activeFilterList().length;
  $("#filterCount").hidden = !active;
  $("#filterCount").textContent = active;
}

function activeFilterList() {
  const f = state.filters;
  const out = [];
  f.colours.forEach((v) => out.push({ label: v, clear: () => f.colours.delete(v) }));
  FACETS.forEach(([key]) => f[key].forEach((v) => out.push({ label: key === "designs" ? `Series ${v}` : v, clear: () => f[key].delete(v) })));
  if (f.minQty) out.push({ label: `${f.minQty}+ m`, clear: () => { f.minQty = 0; } });
  if (f.available) out.push({ label: "In stock", clear: () => { f.available = false; } });
  if (f.inCart) out.push({ label: "In my cart", clear: () => { f.inCart = false; } });
  if (f.q) out.push({ label: `“${f.q}”`, clear: () => { f.q = ""; $("#search").value = ""; } });
  return out;
}

function renderActiveChips() {
  $("#activeChips").replaceChildren(...activeFilterList().map((item) => {
    const b = document.createElement("button");
    b.textContent = item.label;
    b.setAttribute("aria-label", `Remove filter ${item.label}`);
    b.addEventListener("click", () => { item.clear(); apply(); });
    return b;
  }));
}

/* ---------- Grid ---------- */
export function cardHtml(p, i) {
  const tag = p.status === "reserved" ? '<span class="card__tag card__tag--muted">Reserved</span>'
    : p.status === "sold" ? '<span class="card__tag card__tag--muted">Sold</span>'
    : p.featured ? '<span class="card__tag">Signature</span>' : "";
  return `<article class="card" style="--i:${i % CFG.pageSize}">
    <button class="card__frame" data-open="${esc(p.id)}" aria-label="View ${esc(titleOf(p))} full screen">
      <img data-src="${esc(p.thumb)}" alt="${esc(titleOf(p))} — ${esc(p.colourFamily)} ${esc(p.category)}" width="${p.w}" height="${p.h}" decoding="async">
    </button>
    ${tag}
    <button class="card__add" data-cart-btn="${esc(p.id)}" aria-pressed="false" aria-label="Add to cart">${ICON_PLUS}</button>
    <div class="card__body">
      <span class="card__title">${esc(titleOf(p))}</span>
      <span class="card__qty">${esc(qtyText(p.quantity))}</span>
      <span class="card__meta">${esc([p.category, p.composition, seriesText(p)].filter(Boolean).join(" · "))}</span>
    </div>
  </article>`;
}

function renderMore() {
  const next = state.results.slice(state.shown, state.shown + CFG.pageSize);
  if (!next.length) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = next.map((p, i) => cardHtml(p, state.shown + i)).join("");
  lazyImages(tpl.content);
  syncCartButtons(tpl.content);
  $("#grid").append(tpl.content);
  state.shown += next.length;
}

/* ---------- Hero ---------- */
const families = () => [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort(byCategory);

/** n pieces spread over the families in showcase order (silk first), signature pieces preferred. */
function pickShowcase(n, offset = 0) {
  const groups = families().map((c) => {
    const items = state.products.filter((p) => p.category === c);
    const featured = items.filter((p) => p.featured);
    const best = items.filter((p) => !p.featured && p.grade === 1);
    const rest = best.length >= n ? best : items.filter((p) => !p.featured);
    const step = Math.max(1, Math.floor(rest.length / n));
    const spread = rest.filter((_, i) => i % step === offset % step);
    return [...featured, ...spread];
  });
  const out = [];
  for (let round = 0; out.length < n && groups.some((g) => g.length > round); round++) {
    groups.forEach((g) => { if (out.length < n && g[round]) out.push(g[round]); });
  }
  return out;
}

function renderFamilies() {
  const el = $("#families");
  if (!el) return;
  el.innerHTML = families().map((c, i) => {
    const items = state.products.filter((p) => p.category === c);
    const cover = items.find((p) => p.featured) || bestPhoto(items);
    return `<a class="family reveal is-in" href="?category=${encodeURIComponent(c)}#collection" data-family="${esc(c)}">
      <span class="family__media" style="background-image:url('${esc(cover.image)}')"></span>
      <span class="family__num">${["I", "II", "III", "IV", "V"][i] || i + 1}</span>
      <span class="family__body"><strong>${esc(c)}</strong><small>${items.length.toLocaleString()} pieces</small></span>
    </a>`;
  }).join("");
  el.addEventListener("click", (e) => {
    const a = e.target.closest("[data-family]");
    if (!a) return;
    e.preventDefault();
    showOnly("categories", a.dataset.family);
  });
}

const bestPhoto = (items) => items.reduce((a, b) => ((b.photoScore || 0) > (a.photoScore || 0) ? b : a));

/** Best photo among the pieces where the colour stands most alone (fewest accent colours). */
const clearestOf = (items) => {
  const fewest = Math.min(...items.map((p) => p.accents?.length ?? 0));
  return bestPhoto(items.filter((p) => (p.accents?.length ?? 0) === fewest));
};

/** Applies one filter from a home-page tile and jumps to the collection. */
function showOnly(key, value) {
  state.filters = emptyFilters();
  state.filters[key].add(value);
  $("#search").value = "";
  apply();
  $("#collection").scrollIntoView({ behavior: "smooth" });
}

function renderHues() {
  const el = $("#hues");
  if (!el) return;
  el.innerHTML = Object.entries(state.families).map(([name, swatch]) => {
    const items = state.products.filter((p) => p.colourFamily === name);
    if (!items.length) return "";
    return `<a class="hue" href="?colour=${encodeURIComponent(name)}#collection" data-hue="${esc(name)}">
      <span class="hue__media" style="background-image:url('${esc((name === "Multicolour" ? bestPhoto : clearestOf)(items).thumb)}')"></span>
      <span class="hue__body"><i style="--c:${esc(swatch)}" aria-hidden="true"></i><strong>${esc(name)}</strong><small>${items.length}</small></span>
    </a>`;
  }).join("");
  el.addEventListener("click", (e) => {
    const a = e.target.closest("[data-hue]");
    if (!a) return;
    e.preventDefault();
    showOnly("colours", a.dataset.hue);
  });
}

function renderContact() {
  const hello = `Hello ${CFG.brand}, I would like to know more about your fabrics.`;
  const links = [
    CFG.whatsapp && { href: whatsappHref(hello), label: "WhatsApp", cls: "btn--gold", external: true },
    CFG.email && { href: mailHref(`Enquiry — ${CFG.brand}`, hello), label: "Email", cls: "btn--line" },
    { href: "cart.html", label: "Request a quotation", cls: CFG.whatsapp ? "btn--line" : "btn--gold" },
    { href: "showroom.html", label: "Enter the showroom", cls: "btn--ghost" },
  ].filter(Boolean);
  $("#contactChannels").innerHTML = links.map((l) =>
    `<a class="btn ${l.cls}" href="${esc(l.href)}"${l.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(l.label)}</a>`).join("");
}

function renderShowcase() {
  $("#heroMedia").innerHTML = pickShowcase(5).map((p) => `<figure style="background-image:url('${esc(p.thumb)}')"></figure>`).join("");
  $("#maisonMedia").innerHTML = pickShowcase(3, 1).map((p) => `<figure style="background-image:url('${esc(p.image)}')"></figure>`).join("");
  const categories = new Set(state.products.map((p) => p.category).filter(Boolean)).size;
  const metres = Math.round(state.products.reduce((s, p) => s + (p.quantity || 0), 0));
  const stats = [["Pieces", state.products.length.toLocaleString()], ["Categories", categories], ["Metres", metres.toLocaleString()]];
  $("#heroStats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

/* ---------- Events ---------- */
function closeFilterPanel() {
  $("#filters").classList.remove("is-open");
  lockScroll(false);
}

function bind() {
  let timer;
  $("#search").value = state.filters.q;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.filters.q = e.target.value.trim(); apply(); }, 180);
  });
  $("#sort").value = state.sort;
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; apply(); });

  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-facet]");
    if (!btn) return;
    const set = state.filters[btn.dataset.facet];
    if (set.has(btn.dataset.value)) set.delete(btn.dataset.value); else set.add(btn.dataset.value);
    apply();
  });
  $("#fQty").addEventListener("input", (e) => {
    state.filters.minQty = Number(e.target.value);
    $("#fQtyOut").textContent = state.filters.minQty ? `${state.filters.minQty}+ m` : "Any";
  });
  $("#fQty").addEventListener("change", apply);
  $("#fAvailable").addEventListener("change", (e) => { state.filters.available = e.target.checked; apply(); });
  $("#fInCart").addEventListener("change", (e) => { state.filters.inCart = e.target.checked; apply(); });

  const reset = () => { state.filters = emptyFilters(); $("#search").value = ""; apply(); };
  $("#clearFilters").addEventListener("click", reset);
  $("#emptyReset").addEventListener("click", reset);
  $("#openFilters").addEventListener("click", () => { $("#filters").classList.add("is-open"); lockScroll(true); });
  $("#closeFilters").addEventListener("click", closeFilterPanel);
  $("#applyFilters").addEventListener("click", closeFilterPanel);

  const setDensity = (d) => {
    $("#grid").classList.toggle("is-compact", d === "compact");
    $$(".view-switch button").forEach((b) => b.classList.toggle("is-active", b.dataset.density === d));
    storage.set(STORE_DENSITY, d);
  };
  setDensity(storage.get(STORE_DENSITY, "comfortable"));
  $$(".view-switch button").forEach((b) => b.addEventListener("click", () => setDensity(b.dataset.density)));

  $("#grid").addEventListener("click", (e) => {
    const add = e.target.closest("[data-cart-btn]");
    if (add) {
      toggleCart(state.products.find((p) => p.id === add.dataset.cartBtn));
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openViewer(state.results, state.results.findIndex((p) => p.id === open.dataset.open), { syncHash: true });
  });
  cart.onChange(() => {
    syncCartButtons($("#grid"));
    if (state.filters.inCart) apply();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#filters").classList.contains("is-open")) closeFilterPanel();
  });
  window.addEventListener("hashchange", openFromHash);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.shown < state.results.length) renderMore();
    }, { rootMargin: "900px 0px" }).observe($("#sentinel"));
  }
}

function openFromHash() {
  const m = location.hash.match(/^#fabric\/([a-z0-9-]{1,60})$/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  let i = state.results.findIndex((p) => p.id === id);
  let list = state.results;
  if (i < 0) {
    list = state.products;
    i = list.findIndex((p) => p.id === id);
  }
  if (i >= 0) openViewer(list, i, { syncHash: true });
}

async function init() {
  initHeader();
  initReveal();
  readUrl();
  try {
    const data = await loadCatalog();
    state.products = data.products;
    state.families = data.families;
    // Old shared links may name a colour that no longer exists; drop it instead of showing nothing.
    state.filters.colours = new Set([...state.filters.colours].filter((c) => c in state.families));
    cart.prune(data.byId);
  } catch (err) {
    $("#resultCount").textContent = "The collection could not be loaded. Please refresh the page.";
    throw err;
  }
  renderShowcase();
  renderFamilies();
  renderHues();
  renderContact();
  bind();
  apply();
  openFromHash();
}

init();
