/* Luxoria catalogue — vanilla JS, no build step. */
(() => {
  "use strict";

  const CFG = Object.assign({ pageSize: 36, defaultCurrency: "EUR" }, window.LUXORIA_CONFIG || {});
  const STORE_SELECTION = "luxoria.selection";
  const STORE_PRICES = "luxoria.showPrices";
  const STORE_DENSITY = "luxoria.density";
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.4 3.6 5 7 5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 16.4 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
    },
  };

  const emptyFilters = () => ({
    q: "", colours: new Set(), categories: new Set(), collections: new Set(), designs: new Set(),
    minQty: 0, maxPrice: null, available: false, saved: false,
  });

  const state = {
    products: [],
    byId: new Map(),
    families: {},
    filters: emptyFilters(),
    sort: "featured",
    results: [],
    shown: 0,
    selection: new Set(storage.get(STORE_SELECTION, [])),
    showPrices: CFG.allowPriceToggle ? storage.get(STORE_PRICES, !!CFG.showPricesByDefault) : !!CFG.showPricesByDefault,
    viewerIndex: -1,
  };

  /* ---------- Helpers ---------- */
  const titleOf = (p) => p.name || p.article;
  const qtyText = (q) => (q == null ? "On request" : `${Number(q).toFixed(q % 1 ? 1 : 0)} m`);
  const hasPrices = () => state.products.some((p) => p.price != null);
  const pricesVisible = () => state.showPrices && hasPrices();

  function priceText(p) {
    if (p.price == null) return "Price on request";
    const currency = p.currency || CFG.defaultCurrency;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(p.price) + " / m";
    } catch {
      return `${currency} ${p.price} / m`;
    }
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("is-on"), 2400);
  }

  function lockScroll(on) {
    document.body.classList.toggle("is-locked", on);
  }

  /* ---------- Data ---------- */
  async function load() {
    try {
      const res = await fetch("data/products.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.products = (data.products || []).map((p, i) => ({ ...p, _order: i, _search: searchBlob(p) }));
      state.families = data.colourFamilies || {};
      state.products.forEach((p) => state.byId.set(p.id, p));
      // Drop saved ids that no longer exist.
      state.selection = new Set([...state.selection].filter((id) => state.byId.has(id)));
    } catch (err) {
      $("#resultCount").textContent = "The collection could not be loaded. Please refresh the page.";
      throw err;
    }
  }

  function searchBlob(p) {
    return [p.article, p.name, p.collection, p.category, p.designNo, p.colourFamily, p.composition, p.notes]
      .filter(Boolean).join(" ").toLowerCase();
  }

  /* ---------- URL state ---------- */
  function readUrl() {
    const params = new URLSearchParams(location.search);
    const f = state.filters;
    const list = (k) => (params.get(k) || "").split(",").filter(Boolean);
    f.q = params.get("q") || "";
    f.colours = new Set(list("colour"));
    f.categories = new Set(list("category"));
    f.collections = new Set(list("collection"));
    f.designs = new Set(list("design"));
    f.minQty = Number(params.get("min")) || 0;
    f.maxPrice = params.has("maxprice") ? Number(params.get("maxprice")) : null;
    f.available = params.get("stock") === "1";
    f.saved = params.get("saved") === "1";
    state.sort = params.get("sort") || "featured";
  }

  function writeUrl() {
    const f = state.filters;
    const params = new URLSearchParams();
    if (f.q) params.set("q", f.q);
    if (f.colours.size) params.set("colour", [...f.colours].join(","));
    if (f.categories.size) params.set("category", [...f.categories].join(","));
    if (f.collections.size) params.set("collection", [...f.collections].join(","));
    if (f.designs.size) params.set("design", [...f.designs].join(","));
    if (f.minQty) params.set("min", f.minQty);
    if (f.maxPrice != null) params.set("maxprice", f.maxPrice);
    if (f.available) params.set("stock", "1");
    if (f.saved) params.set("saved", "1");
    if (state.sort !== "featured") params.set("sort", state.sort);
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? "?" + qs : ""}${location.hash}`);
  }

  /* ---------- Filtering ---------- */
  function matches(p, f, skip) {
    if (f.q) {
      const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.every((t) => p._search.includes(t))) return false;
    }
    if (skip !== "colours" && f.colours.size && !f.colours.has(p.colourFamily)) return false;
    if (skip !== "categories" && f.categories.size && !f.categories.has(p.category)) return false;
    if (skip !== "collections" && f.collections.size && !f.collections.has(p.collection)) return false;
    if (skip !== "designs" && f.designs.size && !f.designs.has(p.designNo)) return false;
    if (f.minQty && !(p.quantity >= f.minQty)) return false;
    if (f.maxPrice != null && pricesVisible() && p.price != null && p.price > f.maxPrice) return false;
    if (f.available && p.status !== "available") return false;
    if (f.saved && !state.selection.has(p.id)) return false;
    return true;
  }

  const SORTS = {
    featured: (a, b) => (b.featured - a.featured) || (a._order - b._order),
    article: (a, b) => a._order - b._order,
    "article-desc": (a, b) => b._order - a._order,
    "qty-desc": (a, b) => (b.quantity ?? -1) - (a.quantity ?? -1),
    "qty-asc": (a, b) => (a.quantity ?? 1e9) - (b.quantity ?? 1e9),
    "price-asc": (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    "price-desc": (a, b) => (b.price ?? -1) - (a.price ?? -1),
  };

  function apply({ keepScroll = false } = {}) {
    const sorter = SORTS[state.sort] || SORTS.featured;
    state.results = state.products.filter((p) => matches(p, state.filters)).sort(sorter);
    state.shown = 0;
    $("#grid").replaceChildren();
    renderMore();
    renderFacets();
    renderActiveChips();
    renderCount();
    $("#empty").hidden = state.results.length > 0;
    writeUrl();
    if (!keepScroll) $("#collection .collection__body").scrollIntoView({ block: "start" });
  }

  function renderCount() {
    const n = state.results.length;
    const total = state.products.length;
    $("#resultCount").innerHTML = n === total
      ? `<strong>${total}</strong> pieces in the archive`
      : `<strong>${n}</strong> of ${total} pieces`;
  }

  /* ---------- Facets ---------- */
  function countBy(key, skip) {
    const counts = new Map();
    state.products.forEach((p) => {
      if (!matches(p, state.filters, skip)) return;
      const v = p[key];
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
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
        return `<button class="swatch" style="--c:${esc(hex)}" data-facet="colours" data-value="${esc(name)}"
          aria-pressed="${on}" aria-label="${esc(name)} (${n})" ${!n && !on ? "disabled" : ""}><span class="tip">${esc(name)} · ${n}</span></button>`;
      }).join("");

    chipFacet("#fCategory", "categories", "category", "#fCategoryGroup");
    chipFacet("#fCollection", "collections", "collection", "#fCollectionGroup");
    chipFacet("#fDesign", "designs", "designNo");

    const maxQty = Math.ceil(Math.max(1, ...state.products.map((p) => p.quantity || 0)));
    const qty = $("#fQty");
    qty.max = maxQty;
    qty.value = f.minQty;
    $("#fQtyMax").textContent = `${maxQty} m`;
    $("#fQtyOut").textContent = f.minQty ? `${f.minQty}+ m` : "Any";

    const priced = state.products.filter((p) => p.price != null);
    $("#fPriceGroup").hidden = !pricesVisible();
    if (priced.length) {
      const maxP = Math.ceil(Math.max(...priced.map((p) => p.price)));
      const pr = $("#fPrice");
      pr.max = maxP;
      pr.value = f.maxPrice ?? maxP;
      $("#fPriceOut").textContent = f.maxPrice != null ? `≤ ${f.maxPrice}` : "Any";
    }

    $("#fAvailable").checked = f.available;
    $("#fSaved").checked = f.saved;
    const active = activeFilterList().length;
    $("#filterCount").hidden = !active;
    $("#filterCount").textContent = active;
  }

  function chipFacet(sel, facet, key, groupSel) {
    const values = [...new Set(state.products.map((p) => p[key]).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (groupSel) $(groupSel).hidden = values.length < 2;
    const counts = countBy(key, facet);
    $(sel).innerHTML = values.map((v) => {
      const on = state.filters[facet].has(v);
      return `<button class="chip" data-facet="${facet}" data-value="${esc(v)}" aria-pressed="${on}">${esc(v)}<small>${counts.get(v) || 0}</small></button>`;
    }).join("");
  }

  function activeFilterList() {
    const f = state.filters;
    const out = [];
    f.colours.forEach((v) => out.push({ label: v, clear: () => f.colours.delete(v) }));
    f.categories.forEach((v) => out.push({ label: v, clear: () => f.categories.delete(v) }));
    f.collections.forEach((v) => out.push({ label: v, clear: () => f.collections.delete(v) }));
    f.designs.forEach((v) => out.push({ label: `Series ${v}`, clear: () => f.designs.delete(v) }));
    if (f.minQty) out.push({ label: `${f.minQty}+ m`, clear: () => { f.minQty = 0; } });
    if (f.maxPrice != null && pricesVisible()) out.push({ label: `≤ ${f.maxPrice}`, clear: () => { f.maxPrice = null; } });
    if (f.available) out.push({ label: "In stock", clear: () => { f.available = false; } });
    if (f.saved) out.push({ label: "My selection", clear: () => { f.saved = false; } });
    if (f.q) out.push({ label: `“${f.q}”`, clear: () => { f.q = ""; $("#search").value = ""; } });
    return out;
  }

  function renderActiveChips() {
    $("#activeChips").replaceChildren(...activeFilterList().map((item) => {
      const b = document.createElement("button");
      b.textContent = item.label;
      b.setAttribute("aria-label", `Remove filter ${item.label}`);
      b.addEventListener("click", () => { item.clear(); apply({ keepScroll: true }); });
      return b;
    }));
  }

  /* ---------- Grid ---------- */
  const imgObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.src = e.target.dataset.src;
        imgObserver.unobserve(e.target);
      }), { rootMargin: "600px 0px" })
    : null;

  function cardTag(p) {
    if (p.status === "reserved") return '<span class="card__tag card__tag--muted">Reserved</span>';
    if (p.status === "sold") return '<span class="card__tag card__tag--muted">Sold</span>';
    return p.featured ? '<span class="card__tag">Signature</span>' : "";
  }

  function cardPrice(p) {
    if (!pricesVisible()) return `<span class="card__price">${esc(qtyText(p.quantity))}<small>available</small></span>`;
    if (p.price == null) return '<span class="card__price">On request</span>';
    return `<span class="card__price">${esc(priceText(p).replace(" / m", ""))}<small>per metre</small></span>`;
  }

  function cardHtml(p, i) {
    const saved = state.selection.has(p.id);
    const dots = (p.palette || []).slice(0, 4).map((c) => `<span style="--c:${esc(c)}"></span>`).join("");
    return `<article class="card" style="--i:${i % CFG.pageSize}" data-id="${esc(p.id)}">
      <button class="card__frame" data-open="${esc(p.id)}" aria-label="View ${esc(titleOf(p))}">
        <img data-src="${esc(p.thumb)}" alt="${esc(titleOf(p))} — ${esc(p.colourFamily)} ${esc(p.category)}" width="${p.w}" height="${p.h}" decoding="async">
        <span class="card__view">View the piece</span>
      </button>
      ${cardTag(p)}
      <button class="card__save" data-save="${esc(p.id)}" aria-pressed="${saved}" aria-label="${saved ? "Remove from" : "Add to"} selection">${HEART}</button>
      <div class="card__body">
        <span class="card__title">${esc(titleOf(p))}</span>
        ${cardPrice(p)}
        <span class="card__meta">${esc([p.category, p.designNo && `Series ${p.designNo}`].filter(Boolean).join(" · "))}</span>
        <span class="card__dots">${dots}</span>
      </div>
    </article>`;
  }

  function renderMore() {
    const next = state.results.slice(state.shown, state.shown + CFG.pageSize);
    if (!next.length) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = next.map((p, i) => cardHtml(p, state.shown + i)).join("");
    $$("img", tpl.content).forEach((img) => {
      img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
      if (imgObserver) imgObserver.observe(img); else img.src = img.dataset.src;
    });
    $("#grid").append(tpl.content);
    state.shown += next.length;
  }

  function refreshCards() {
    const shown = state.shown;
    state.shown = 0;
    $("#grid").replaceChildren();
    while (state.shown < shown) renderMore();
  }

  /* ---------- Selection ---------- */
  function toggleSave(id) {
    const p = state.byId.get(id);
    if (!p) return;
    const added = !state.selection.has(id);
    if (added) state.selection.add(id); else state.selection.delete(id);
    storage.set(STORE_SELECTION, [...state.selection]);
    $$(`.card__save[data-save="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute("aria-pressed", added);
      b.setAttribute("aria-label", `${added ? "Remove from" : "Add to"} selection`);
    });
    renderSelectionCount(true);
    renderDrawer();
    if (state.viewerIndex >= 0) renderViewerSave();
    toast(added ? `${titleOf(p)} added to your selection` : `${titleOf(p)} removed`);
    if (state.filters.saved) apply({ keepScroll: true });
  }

  function renderSelectionCount(bump) {
    $("#selectionCount").textContent = state.selection.size;
    if (!bump) return;
    const btn = $("#openSelection");
    btn.classList.remove("is-bump");
    void btn.offsetWidth;
    btn.classList.add("is-bump");
  }

  function selectedProducts() {
    return [...state.selection].map((id) => state.byId.get(id)).filter(Boolean);
  }

  function renderDrawer() {
    const items = selectedProducts();
    const list = $("#drawerList");
    if (!items.length) {
      list.innerHTML = '<li class="empty-note">Your selection is empty.<br>Tap the heart on any fabric to begin.</li>';
    } else {
      list.innerHTML = items.map((p) => `<li>
        <img src="${esc(p.thumb)}" alt="" data-open="${esc(p.id)}">
        <div><strong>${esc(titleOf(p))}</strong><span>${esc([p.designNo && `Series ${p.designNo}`, qtyText(p.quantity), pricesVisible() ? priceText(p) : ""].filter(Boolean).join(" · "))}</span></div>
        <button class="icon-btn" data-save="${esc(p.id)}" aria-label="Remove ${esc(titleOf(p))}">✕</button>
      </li>`).join("");
    }
    $("#drawerFoot").hidden = !items.length;
    updateEnquiryLinks();
  }

  function pageUrl(id) {
    return `${location.origin}${location.pathname}#fabric/${encodeURIComponent(id)}`;
  }

  function enquiryText(items) {
    const name = $("#enqName").value.trim();
    const msg = $("#enqMsg").value.trim();
    const lines = [
      `Hello ${CFG.brand || "Luxoria"},`,
      "",
      `I would like to request: ${$("#enqType").value}.`,
      "",
      ...items.map((p, i) => `${i + 1}. ${titleOf(p)}${p.designNo ? ` (Series ${p.designNo})` : ""} — ${qtyText(p.quantity)} — ${pageUrl(p.id)}`),
    ];
    if (msg) lines.push("", msg);
    if (name) lines.push("", `— ${name}`);
    return lines.join("\n");
  }

  function whatsappHref(text) {
    const num = String(CFG.whatsapp || "").replace(/\D/g, "");
    return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
  }

  function mailHref(subject, body) {
    return `mailto:${CFG.email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function updateEnquiryLinks() {
    const items = selectedProducts();
    const text = enquiryText(items);
    $("#sendWhatsapp").href = whatsappHref(text);
    $("#sendEmail").href = mailHref(`${$("#enqType").value} request — ${items.length} piece${items.length === 1 ? "" : "s"}`, text);
  }

  function openDrawer() {
    renderDrawer();
    $("#drawer").hidden = false;
    lockScroll(true);
  }

  function closeDrawer() {
    $("#drawer").hidden = true;
    if ($("#viewer").hidden) lockScroll(false);
  }

  /* ---------- Viewer ---------- */
  function setFabricHash(id) {
    history.replaceState(null, "", `${location.pathname}${location.search}#fabric/${encodeURIComponent(id)}`);
  }

  function openViewer(id) {
    let idx = state.results.findIndex((p) => p.id === id);
    if (idx < 0) {
      const p = state.byId.get(id);
      if (!p) return;
      state.results = [p, ...state.results];
      idx = 0;
    }
    state.viewerIndex = idx;
    renderViewer();
    $("#viewer").hidden = false;
    lockScroll(true);
    setFabricHash(id);
    $(".viewer__close").focus({ preventScroll: true });
  }

  function closeViewer() {
    $("#viewer").hidden = true;
    state.viewerIndex = -1;
    if ($("#drawer").hidden) lockScroll(false);
    if (location.hash.startsWith("#fabric/")) history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  function stepViewer(dir) {
    if (state.viewerIndex < 0 || !state.results.length) return;
    state.viewerIndex = (state.viewerIndex + dir + state.results.length) % state.results.length;
    renderViewer();
    setFabricHash(state.results[state.viewerIndex].id);
  }

  function renderViewer() {
    const p = state.results[state.viewerIndex];
    const img = $("#vImg");
    img.classList.add("is-loading");
    img.onload = () => img.classList.remove("is-loading");
    img.src = p.image;
    img.alt = `${titleOf(p)} — ${p.colourFamily} ${p.category}`;
    $("#vLens").style.backgroundImage = `url("${p.image}")`;
    $("#vEyebrow").textContent = [p.collection, p.category].filter(Boolean).join(" · ");
    $("#vTitle").textContent = titleOf(p);
    $("#vPrice").textContent = pricesVisible() ? priceText(p) : "";
    $("#vPrice").hidden = !pricesVisible();
    const specs = [
      ["Article", p.article],
      ["Design series", p.designNo],
      ["Available", qtyText(p.quantity)],
      ["Width", p.width ? `${p.width} cm` : ""],
      ["Composition", p.composition],
      ["Colour", p.colourFamily],
      ["Origin", "Made in Italy"],
      ["Status", p.status ? p.status[0].toUpperCase() + p.status.slice(1) : ""],
      ["Note", p.notes],
    ].filter(([, v]) => v);
    $("#vSpecs").innerHTML = specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    $("#vPalette").innerHTML = (p.palette || []).map((c) => `<span style="--c:${esc(c)}" data-hex="${esc(c)}"></span>`).join("");
    const text = `Hello ${CFG.brand || "Luxoria"}, I am interested in ${titleOf(p)}${p.designNo ? ` (Series ${p.designNo})` : ""} — ${pageUrl(p.id)}`;
    $("#vEnquire").href = CFG.whatsapp ? whatsappHref(text) : mailHref(`Enquiry — ${titleOf(p)}`, text);
    renderViewerSave();
    const many = state.results.length > 1;
    $("#vPrev").hidden = !many;
    $("#vNext").hidden = !many;
  }

  function renderViewerSave() {
    const p = state.results[state.viewerIndex];
    if (!p) return;
    const saved = state.selection.has(p.id);
    const btn = $("#vSave");
    btn.dataset.save = p.id;
    btn.innerHTML = `${HEART}<span>${saved ? "In your selection" : "Add to selection"}</span>`;
  }

  function initLens() {
    const stage = $("#vStage");
    const lens = $("#vLens");
    const img = $("#vImg");
    const ZOOM = 2.6;
    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      // Rendered image box inside the object-fit: contain frame.
      const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const x = e.clientX - (r.left + (r.width - w) / 2);
      const y = e.clientY - (r.top + (r.height - h) / 2);
      const inside = x >= 0 && y >= 0 && x <= w && y <= h && !e.target.closest("button");
      lens.classList.toggle("is-on", inside);
      if (!inside) return;
      const sr = stage.getBoundingClientRect();
      const size = lens.offsetWidth;
      lens.style.transform = `translate(${e.clientX - sr.left - size / 2}px, ${e.clientY - sr.top - size / 2}px)`;
      lens.style.backgroundSize = `${w * ZOOM}px ${h * ZOOM}px`;
      lens.style.backgroundPosition = `${-(x * ZOOM - size / 2)}px ${-(y * ZOOM - size / 2)}px`;
    });
    stage.addEventListener("pointerleave", () => lens.classList.remove("is-on"));
    img.addEventListener("click", openZoom);
  }

  /* ---------- Fullscreen zoom ---------- */
  function openZoom() {
    const p = state.results[state.viewerIndex];
    if (!p) return;
    $("#zoomImg").src = p.image;
    $("#zoomImg").alt = titleOf(p);
    $("#zoom").hidden = false;
    const sc = $("#zoomScroller");
    requestAnimationFrame(() => { sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2; sc.scrollTop = 0; });
  }

  function initZoomDrag() {
    const sc = $("#zoomScroller");
    let drag = null;
    sc.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      drag = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop };
      sc.classList.add("is-dragging");
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      sc.scrollLeft = drag.l - (e.clientX - drag.x);
      sc.scrollTop = drag.t - (e.clientY - drag.y);
    });
    window.addEventListener("pointerup", () => { drag = null; sc.classList.remove("is-dragging"); });
    $("#zoomClose").addEventListener("click", () => { $("#zoom").hidden = true; });
  }

  /* ---------- Decorative sections ---------- */
  function pickShowcase(n) {
    const pool = state.products.filter((p) => p.featured);
    const rest = state.products.filter((p) => !p.featured);
    const step = Math.max(1, Math.floor(rest.length / n));
    for (let i = 0; pool.length < n && i < rest.length; i += step) pool.push(rest[i]);
    return pool.slice(0, n);
  }

  function renderShowcase() {
    $("#heroMedia").innerHTML = pickShowcase(5)
      .map((p) => `<figure style="background-image:url('${esc(p.thumb)}')"></figure>`).join("");
    $("#maisonMedia").innerHTML = pickShowcase(9).slice(-3)
      .map((p) => `<figure style="background-image:url('${esc(p.image)}')"></figure>`).join("");

    const series = new Set(state.products.map((p) => p.designNo).filter(Boolean)).size;
    const metres = Math.round(state.products.reduce((s, p) => s + (p.quantity || 0), 0));
    const stats = [["Pieces", state.products.length], ["Series", series], ["Metres", metres.toLocaleString()]];
    $("#heroStats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  }

  function renderContact() {
    const links = [];
    if (CFG.whatsapp) links.push(`<a class="btn btn--gold" href="${esc(whatsappHref(`Hello ${CFG.brand}, I would like to know more about your fabrics.`))}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (CFG.email) links.push(`<a class="btn btn--line" href="mailto:${esc(CFG.email)}">${esc(CFG.email)}</a>`);
    links.push('<button class="btn btn--ghost" data-open-selection>Send my selection</button>');
    $("#contactChannels").innerHTML = links.join("");
    if (CFG.showroom) $(".contact__lede").textContent = `${CFG.showroom}. Our advisors reply personally, usually within one business day.`;
  }

  /* ---------- Prices ---------- */
  function syncPriceSortOptions() {
    $$("#sort option[data-price]").forEach((o) => { o.hidden = !pricesVisible(); });
    if (!pricesVisible() && state.sort.startsWith("price")) state.sort = "featured";
    $("#sort").value = state.sort;
  }

  function initPriceToggle() {
    const input = $("#priceToggle");
    $("#priceSwitch").hidden = !CFG.allowPriceToggle;
    input.checked = state.showPrices;
    syncPriceSortOptions();
    input.addEventListener("change", () => {
      state.showPrices = input.checked;
      storage.set(STORE_PRICES, state.showPrices);
      syncPriceSortOptions();
      if (state.showPrices && !hasPrices()) toast("Prices are shared on request — add pieces to your selection to ask.");
      refreshCards();
      renderFacets();
      renderActiveChips();
      if (state.viewerIndex >= 0) renderViewer();
    });
  }

  /* ---------- Chrome: nav, reveal, infinite scroll ---------- */
  function initNav() {
    const nav = $("#nav");
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const hide = y > lastY && y > 400;
      nav.classList.toggle("is-solid", y > 40);
      nav.classList.toggle("is-hidden", hide);
      document.body.classList.toggle("nav-visible", !hide);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  function initReveal() {
    const els = $$(".reveal");
    if (!("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("is-in")); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }), { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
  }

  function initInfiniteScroll() {
    if (!("IntersectionObserver" in window)) return;
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.shown < state.results.length) renderMore();
    }, { rootMargin: "900px 0px" }).observe($("#sentinel"));
  }

  /* ---------- Events ---------- */
  function bindFilters() {
    let searchTimer;
    $("#search").value = state.filters.q;
    $("#search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); apply({ keepScroll: true }); }, 180);
    });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; apply({ keepScroll: true }); });

    $("#filters").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-facet]");
      if (!btn) return;
      const set = state.filters[btn.dataset.facet];
      const v = btn.dataset.value;
      if (set.has(v)) set.delete(v); else set.add(v);
      apply({ keepScroll: true });
    });
    $("#fQty").addEventListener("input", (e) => {
      state.filters.minQty = Number(e.target.value);
      $("#fQtyOut").textContent = state.filters.minQty ? `${state.filters.minQty}+ m` : "Any";
    });
    $("#fQty").addEventListener("change", () => apply({ keepScroll: true }));
    $("#fPrice").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      state.filters.maxPrice = v >= Number(e.target.max) ? null : v;
      $("#fPriceOut").textContent = state.filters.maxPrice != null ? `≤ ${v}` : "Any";
    });
    $("#fPrice").addEventListener("change", () => apply({ keepScroll: true }));
    $("#fAvailable").addEventListener("change", (e) => { state.filters.available = e.target.checked; apply({ keepScroll: true }); });
    $("#fSaved").addEventListener("change", (e) => { state.filters.saved = e.target.checked; apply({ keepScroll: true }); });

    const reset = () => { state.filters = emptyFilters(); $("#search").value = ""; apply({ keepScroll: true }); };
    $("#clearFilters").addEventListener("click", reset);
    $("#emptyReset").addEventListener("click", reset);

    const filters = $("#filters");
    $("#openFilters").addEventListener("click", () => { filters.classList.add("is-open"); lockScroll(true); });
    $("#closeFilters").addEventListener("click", closeFilterPanel);
    $("#applyFilters").addEventListener("click", closeFilterPanel);

    const setDensity = (d) => {
      $("#grid").classList.toggle("is-compact", d === "compact");
      $$(".view-switch button").forEach((b) => b.classList.toggle("is-active", b.dataset.density === d));
      storage.set(STORE_DENSITY, d);
    };
    setDensity(storage.get(STORE_DENSITY, "comfortable"));
    $$(".view-switch button").forEach((b) => b.addEventListener("click", () => setDensity(b.dataset.density)));
  }

  function closeFilterPanel() {
    $("#filters").classList.remove("is-open");
    lockScroll(false);
  }

  function bindGlobal() {
    document.addEventListener("click", (e) => {
      const save = e.target.closest("[data-save]");
      if (save) { e.preventDefault(); toggleSave(save.dataset.save); return; }
      const open = e.target.closest("[data-open]");
      if (open) { closeDrawer(); openViewer(open.dataset.open); return; }
      if (e.target.closest("[data-open-selection], #openSelection")) { openDrawer(); return; }
      if (e.target.closest("[data-close]")) { closeViewer(); return; }
      if (e.target.closest("[data-close-drawer]")) closeDrawer();
    });

    $("#vPrev").addEventListener("click", () => stepViewer(-1));
    $("#vNext").addEventListener("click", () => stepViewer(1));
    $("#vShare").addEventListener("click", async () => {
      const url = pageUrl(state.results[state.viewerIndex].id);
      try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast(url); }
    });

    ["#enqName", "#enqType", "#enqMsg"].forEach((s) => $(s).addEventListener("input", updateEnquiryLinks));
    $("#clearSelection").addEventListener("click", () => {
      state.selection.clear();
      storage.set(STORE_SELECTION, []);
      $$('.card__save[aria-pressed="true"]').forEach((b) => b.setAttribute("aria-pressed", "false"));
      renderSelectionCount(false);
      renderDrawer();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#zoom").hidden) $("#zoom").hidden = true;
        else if (!$("#viewer").hidden) closeViewer();
        else if (!$("#drawer").hidden) closeDrawer();
        else if ($("#filters").classList.contains("is-open")) closeFilterPanel();
        return;
      }
      if (!$("#viewer").hidden && $("#zoom").hidden) {
        if (e.key === "ArrowLeft") stepViewer(-1);
        if (e.key === "ArrowRight") stepViewer(1);
      }
    });

    window.addEventListener("hashchange", openFromHash);
  }

  function openFromHash() {
    const m = location.hash.match(/^#fabric\/(.+)$/);
    if (m) openViewer(decodeURIComponent(m[1]));
  }

  /* ---------- Boot ---------- */
  async function init() {
    $("#year").textContent = new Date().getFullYear();
    initNav();
    initReveal();
    readUrl();
    try { await load(); } catch { return; }
    initPriceToggle();
    renderShowcase();
    renderContact();
    renderSelectionCount(false);
    bindFilters();
    bindGlobal();
    initLens();
    initZoomDrag();
    apply({ keepScroll: true });
    initInfiniteScroll();
    openFromHash();
  }

  init();
})();
