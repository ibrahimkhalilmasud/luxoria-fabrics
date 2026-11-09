/* Admin corrections to the catalogue (Supabase table public.product_edits).
   Shared by the public pages (read) and the admin area (read + write). */

// Database column -> product field in data/products.json.
export const EDIT_FIELDS = {
  article: "article",
  name: "name",
  category: "category",
  design_no: "designNo",
  quantity: "quantity",
  width: "width",
  composition: "composition",
  colour_family: "colourFamily",
  status: "status",
  featured: "featured",
  notes: "notes",
};
// Photo columns are optional: they only exist after supabase/migrations/2026-11-photo-and-delete.sql.
// Everything below works with or without them, so the site never breaks if they are missing.
const PHOTO_COLUMNS = ["image_url", "thumb_url", "image_w", "image_h"];
export const BASE_EDIT_COLUMNS = ["product_id", ...Object.keys(EDIT_FIELDS)].join(",");
export const EDIT_COLUMNS = [BASE_EDIT_COLUMNS, ...PHOTO_COLUMNS].join(",");
export const isCustomPhoto = (url) => /^https:\/\//.test(url || "");
export const STATUSES = ["available", "reserved", "sold", "hidden"];

const toNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Product with one saved edit row laid over it. */
export function applyEdit(product, row) {
  if (!row) return product;
  const out = { ...product };
  for (const [col, field] of Object.entries(EDIT_FIELDS)) out[field] = row[col];
  out.quantity = toNumber(row.quantity);
  out.width = toNumber(row.width);
  if (isCustomPhoto(row.image_url) && isCustomPhoto(row.thumb_url)) {
    out.image = row.image_url;
    out.thumb = row.thumb_url;
    if (row.image_w && row.image_h) { out.w = row.image_w; out.h = row.image_h; }
  }
  out.edited = true;
  return out;
}

/** Product fields -> database row for product_edits. */
export function toEditRow(id, p, { photo = false } = {}) {
  const row = { product_id: id };
  for (const [col, field] of Object.entries(EDIT_FIELDS)) row[col] = p[field] ?? "";
  row.quantity = p.quantity ?? null; // empty numbers mean "on request" / unknown
  row.width = p.width ?? null;
  row.status = p.status || "available";
  row.featured = !!p.featured;
  if (photo) { // only when the database has the photo columns
    const custom = isCustomPhoto(p.image) && isCustomPhoto(p.thumb); // the published photo is never copied here
    row.image_url = custom ? p.image : null;
    row.thumb_url = custom ? p.thumb : null;
    row.image_w = custom ? p.w : null;
    row.image_h = custom ? p.h : null;
  }
  return row;
}

/** All edit rows from Supabase as a Map(product_id -> row); an empty Map when unavailable. */
export async function fetchEdits(cfg, { timeoutMs = 5000 } = {}) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.supabaseUrl || "") || !cfg.supabaseKey) return new Map();
  try {
    const headers = { apikey: cfg.supabaseKey };
    if (cfg.supabaseKey.startsWith("ey")) headers.Authorization = `Bearer ${cfg.supabaseKey}`;
    const get = (columns) => fetch(`${cfg.supabaseUrl}/rest/v1/product_edits?select=${columns}`, {
      headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await get(EDIT_COLUMNS);
    if (!res.ok) res = await get(BASE_EDIT_COLUMNS); // photo columns not added yet: show the details as before
    if (!res.ok) return new Map();
    const rows = await res.json();
    return new Map((Array.isArray(rows) ? rows : []).map((r) => [r.product_id, r]));
  } catch {
    return new Map(); // the published catalogue still shows if Supabase is unreachable
  }
}
