/* Shared building blocks for every public page: config, catalogue, cart, helpers. */

export const CFG = Object.freeze({ brand: "Luxoria", pageSize: 36, ...(window.LUXORIA_CONFIG || {}) });

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
export const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>';
export const ICON_BAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 12.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8L5 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: memory only */ }
  },
};

/* ---------- Catalogue ---------- */
let catalogPromise = null;

export function loadCatalog() {
  catalogPromise ??= fetch("data/products.json", { cache: "no-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`Catalogue HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const products = (data.products || []).map((p, i) => ({
        ...p,
        _order: i,
        _search: [p.article, p.name, p.collection, p.category, p.designNo, p.colourFamily, p.composition, p.notes]
          .filter(Boolean).join(" ").toLowerCase(),
      }));
      return { products, byId: new Map(products.map((p) => [p.id, p])), families: data.colourFamilies || {} };
    });
  return catalogPromise;
}

/* Showcase order of the fabric families; anything else follows alphabetically. */
export const CATEGORY_ORDER = ["Silk", "Embroidery", "Lace"];
export const categoryRank = (c) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? CATEGORY_ORDER.length : i;
};
export const byCategory = (a, b) => (categoryRank(a) - categoryRank(b)) || String(a).localeCompare(String(b));

export const titleOf = (p) => p.name || p.article;
export const qtyText = (q) => (q == null ? "On request" : `${Number(q).toFixed(q % 1 ? 1 : 0)} m`);
export const seriesText = (p) => (p.designNo ? `Series ${p.designNo}` : "");
export const productUrl = (id) => new URL(`index.html#fabric/${encodeURIComponent(id)}`, location.href).href;

export function specsOf(p) {
  return [
    ["Article", p.article],
    ["Collection", p.collection],
    ["Category", p.category],
    ["Design series", p.designNo],
    ["Available", qtyText(p.quantity)],
    ["Width", p.width ? `${p.width} cm` : ""],
    ["Composition / quality", p.composition],
    ["Colour", [p.colourFamily, p.accents?.length ? `with ${p.accents.join(", ")}` : ""].filter(Boolean).join(" · ")],
    ["Status", p.status ? p.status[0].toUpperCase() + p.status.slice(1) : ""],
    ["Note", p.notes],
  ].filter(([, v]) => v);
}

/* ---------- Cart (shared across pages and tabs) ---------- */
const CART_KEY = "luxoria.cart";
const MAX_CART = 200;
const listeners = new Set();
let cartIds = storage.get(CART_KEY, []).filter((x) => typeof x === "string").slice(0, MAX_CART);

function emitCart() {
  storage.set(CART_KEY, cartIds);
  listeners.forEach((fn) => fn(cartIds));
}

export const cart = {
  ids: () => [...cartIds],
  has: (id) => cartIds.includes(id),
  size: () => cartIds.length,
  add(id) {
    if (cartIds.includes(id)) return false;
    if (cartIds.length >= MAX_CART) {
      toast(`Your cart is full (${MAX_CART} pieces).`);
      return false;
    }
    cartIds = [...cartIds, id];
    emitCart();
    return true;
  },
  remove(id) {
    cartIds = cartIds.filter((x) => x !== id);
    emitCart();
  },
  toggle(id) {
    if (cartIds.includes(id)) {
      cart.remove(id);
      return false;
    }
    return cart.add(id);
  },
  clear() {
    cartIds = [];
    emitCart();
  },
  prune(validIds) {
    const next = cartIds.filter((id) => validIds.has(id));
    if (next.length !== cartIds.length) {
      cartIds = next;
      emitCart();
    }
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

window.addEventListener("storage", (e) => {
  if (e.key !== CART_KEY) return;
  cartIds = storage.get(CART_KEY, []);
  listeners.forEach((fn) => fn(cartIds));
});

/** Add/remove from cart with feedback. Returns the new "in cart" state. */
export function toggleCart(p) {
  const inCart = cart.toggle(p.id);
  if (inCart) toast(`${titleOf(p)} added to cart`, { href: "cart.html", label: "View cart" });
  else if (!cart.has(p.id)) toast(`${titleOf(p)} removed from cart`);
  return cart.has(p.id);
}

/** Keep every [data-cart-btn="id"] in sync with the cart. */
export function syncCartButtons(root = document) {
  $$("[data-cart-btn]", root).forEach((b) => {
    const on = cart.has(b.dataset.cartBtn);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Remove from cart" : "Add to cart");
    b.innerHTML = on ? ICON_CHECK : ICON_PLUS;
  });
}

/* ---------- Header ---------- */
export function initHeader() {
  const nav = $("#nav");
  const count = $("#cartCount");
  const link = $("#cartLink");
  const render = (bump) => {
    count.textContent = cart.size();
    count.hidden = cart.size() === 0;
    if (!bump) return;
    link.classList.remove("is-bump");
    void link.offsetWidth;
    link.classList.add("is-bump");
  };
  render(false);
  cart.onChange(() => render(true));

  let lastY = window.scrollY;
  const onScroll = () => {
    const y = window.scrollY;
    const hide = y > lastY && y > 400 && !nav.classList.contains("is-pinned");
    nav.classList.toggle("is-solid", y > 40 || nav.classList.contains("is-pinned"));
    nav.classList.toggle("is-hidden", hide);
    document.body.classList.toggle("nav-visible", !hide);
    lastY = y;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const year = $("#year");
  if (year) year.textContent = new Date().getFullYear();
}

export function initReveal() {
  const els = $$(".reveal");
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("is-in");
    io.unobserve(e.target);
  }), { threshold: 0.15 });
  els.forEach((el) => io.observe(el));
}

/* ---------- Toast ---------- */
export function toast(msg, action) {
  const el = $("#toast");
  if (!el) return;
  el.replaceChildren(document.createTextNode(msg));
  if (action) {
    const a = document.createElement("a");
    a.href = action.href;
    a.textContent = action.label;
    el.append(a);
  }
  el.classList.add("is-on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("is-on"), 2800);
}

export function lockScroll(on) {
  document.body.classList.toggle("is-locked", on);
}

/* ---------- Contact links ---------- */
export function whatsappHref(text, number = CFG.whatsapp) {
  const num = String(number || "").replace(/\D/g, "");
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

export function mailHref(subject, body, to = CFG.email) {
  return `mailto:${to || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Lazy-load <img data-src> elements as they approach the viewport. */
export const lazyImages = (() => {
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.src = e.target.dataset.src;
        io.unobserve(e.target);
      }), { rootMargin: "800px 800px" })
    : null;
  return (root) => $$("img[data-src]", root).forEach((img) => {
    img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    if (io) io.observe(img); else img.src = img.dataset.src;
  });
})();
