"""Build the Luxoria catalogue from a folder of raw fabric photos.

For every photo it:
  * writes a web-optimised full image  -> site/images/full/<id>.webp
  * writes a grid thumbnail            -> site/images/thumb/<id>.webp
  * detects the dominant colour and maps it to a colour family (for filtering)
and merges optional metadata from:
  * catalogue PDFs (Design No / Qty / Article), via --pdfs
  * data/catalog.csv  (your editable master sheet: name, width, composition, status ...)

Prices are deliberately NOT handled here: this repository is public. Prices are
managed in the admin panel and stored in Supabase behind admin-only access.

Usage:
  python tools/build_catalog.py --source "<photo folder>" --collection CEMB --category Lace
  python tools/build_catalog.py --source "<folder>" --collection CEMB --pdfs "<folder with PDFs>"
  python tools/build_catalog.py --source "<silk folder>" --collection Silk --category Silk --parse-names silk

Already-converted images are skipped, so re-running after adding photos is fast.
"""

from __future__ import annotations

import argparse
import colorsys
import csv
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

from name_parsers import parse_embroidery_name, parse_silk_name

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
FULL_DIR = SITE / "images" / "full"
THUMB_DIR = SITE / "images" / "thumb"
PRODUCTS_JSON = SITE / "data" / "products.json"
CATALOG_CSV = ROOT / "data" / "catalog.csv"

FULL_MAX_EDGE = 1600
THUMB_WIDTH = 400
FULL_QUALITY = 70
THUMB_QUALITY = 62
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
NAME_PARSERS = {"silk": parse_silk_name, "embroidery": parse_embroidery_name}
# Showcase order of the categories; anything else follows alphabetically.
CATEGORY_ORDER = ["Silk", "Embroidery", "Lace"]

CSV_FIELDS = [
    "id", "article", "name", "collection", "category", "design_no", "quantity_m",
    "width_cm", "composition", "colour_family", "status",
    "featured", "notes",
]

# Colour family -> swatch hex, used for detection labels and the UI chips.
COLOUR_FAMILIES = {
    "Noir": "#121212",
    "Ivory": "#efe6d2",
    "Champagne": "#d9bf8f",
    "Gold": "#b8892f",
    "Copper": "#b8653a",
    "Blush": "#e4a7a0",
    "Rouge": "#9e1b2c",
    "Fuchsia": "#c2307a",
    "Violet": "#5e3a8c",
    "Sapphire": "#1f4fa3",
    "Teal": "#1f7f86",
    "Emerald": "#1f6b45",
    "Silver": "#a7a9ac",
}


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def classify_colour(rgb: tuple[int, int, int]) -> str:
    h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
    hue = h * 360
    if l < 0.17:
        return "Noir"
    if s < 0.14:
        if l > 0.78:
            return "Ivory"
        return "Silver" if l > 0.35 else "Noir"
    if hue < 12 or hue >= 345:
        return "Blush" if l > 0.62 else "Rouge"
    if hue < 32:
        return "Blush" if l > 0.68 else "Copper"
    if hue < 52:
        if l > 0.72:
            return "Ivory"
        return "Champagne" if l > 0.55 else "Gold"
    if hue < 70:
        return "Champagne" if l > 0.55 else "Gold"
    if hue < 165:
        return "Emerald"
    if hue < 195:
        return "Teal"
    if hue < 255:
        return "Sapphire"
    if hue < 295:
        return "Violet"
    return "Fuchsia"


def dominant_colours(im: Image.Image) -> tuple[str, list[str]]:
    """Return (family of the most present colour, palette of 4 hex accents)."""
    small = im.copy()
    small.thumbnail((160, 160))
    quant = small.quantize(colors=6, method=Image.Quantize.MEDIANCUT)
    palette = quant.getpalette()
    counts = sorted(quant.getcolors(), reverse=True)
    swatches = []
    families: dict[str, int] = {}
    for count, idx in counts:
        rgb = tuple(palette[idx * 3: idx * 3 + 3])
        swatches.append("#%02x%02x%02x" % rgb)
        fam = classify_colour(rgb)
        families[fam] = families.get(fam, 0) + count
    # A dark ground with colourful embroidery reads as the embroidery colour
    # unless the black dominates overwhelmingly.
    total = sum(families.values())
    ordered = sorted(families.items(), key=lambda kv: kv[1], reverse=True)
    family = ordered[0][0]
    if family == "Noir" and len(ordered) > 1 and ordered[0][1] / total < 0.55:
        family = ordered[1][0]
    return family, swatches[:4]


def process_image(job: tuple[str, str, bool]) -> dict:
    src, pid, force = job
    full_path = FULL_DIR / f"{pid}.webp"
    thumb_path = THUMB_DIR / f"{pid}.webp"
    with Image.open(src) as raw:
        im = ImageOps.exif_transpose(raw).convert("RGB")
        if force or not full_path.exists():
            full = im.copy()
            full.thumbnail((FULL_MAX_EDGE, FULL_MAX_EDGE), Image.Resampling.LANCZOS)
            full.save(full_path, "WEBP", quality=FULL_QUALITY, method=5)
        if force or not thumb_path.exists():
            ratio = THUMB_WIDTH / im.width
            thumb = im.resize((THUMB_WIDTH, max(1, round(im.height * ratio))), Image.Resampling.LANCZOS)
            thumb.save(thumb_path, "WEBP", quality=THUMB_QUALITY, method=5)
        family, palette = dominant_colours(im)
    with Image.open(full_path) as f:
        w, h = f.size
    return {"id": pid, "colour_family": family, "palette": palette, "w": w, "h": h}


def read_pdf_metadata(pdf_dir: Path | None) -> dict[str, dict]:
    if not pdf_dir:
        return {}
    try:
        import pypdf
    except ImportError:
        print("pypdf not installed - skipping PDF metadata (pip install pypdf)")
        return {}
    meta: dict[str, dict] = {}
    pattern = re.compile(
        r"DESIGN NO\s*:\s*(?P<design>\S+).*?Qty\s*:\s*(?P<qty>[\d.]+)\s*MT"
        r".*?ARTICLE\s*:\s*\w+\s+(?P<art>\d+)(?P<rest>.*)",
        re.I,
    )
    for pdf in sorted(pdf_dir.glob("*.pdf")):
        for page in pypdf.PdfReader(str(pdf)).pages:
            text = re.sub(r"\s+", " ", page.extract_text() or "")
            m = pattern.search(text)
            if not m:
                continue
            note = m.group("rest").strip(" :")
            meta[m.group("art")] = {
                "design_no": m.group("design"),
                "quantity_m": float(m.group("qty")),
                "notes": note.title() if note else "",
            }
    return meta


def read_catalog_csv() -> dict[str, dict]:
    if not CATALOG_CSV.exists():
        return {}
    with CATALOG_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return {row["id"]: row for row in csv.DictReader(fh) if row.get("id")}


def write_catalog_csv(rows: list[dict]) -> None:
    CATALOG_CSV.parent.mkdir(parents=True, exist_ok=True)
    with CATALOG_CSV.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in CSV_FIELDS})


def load_previous_products() -> dict[str, dict]:
    try:
        data = json.loads(PRODUCTS_JSON.read_text(encoding="utf-8"))
        return {p["id"]: p for p in data["products"]}
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return {}


def to_number(value) -> float | None:
    text = str(value or "").replace(",", "").strip()
    try:
        return float(text) if text else None
    except ValueError:
        return None


def natural_key(p: dict):
    cat = p["category"]
    rank = CATEGORY_ORDER.index(cat) if cat in CATEGORY_ORDER else len(CATEGORY_ORDER)
    return [rank, cat, p["collection"]] + [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", p["article"])]


def new_csv_row(pid: str, article: str, args: argparse.Namespace, pdf_meta: dict, name_meta: dict) -> dict:
    number = re.match(r"\d+", article)
    pm = {**pdf_meta.get(number.group(0) if number else "", {}), **name_meta}
    return {
        "id": pid,
        "article": f"{args.collection} {article}",
        "collection": args.collection,
        "category": args.category,
        "design_no": pm.get("design_no", ""),
        "quantity_m": pm.get("quantity_m", ""),
        "status": "available",
        "composition": pm.get("composition", ""),
        "notes": pm.get("notes", ""),
    }


def to_product(row: dict, img: dict) -> dict:
    pid = row["id"]
    return {
        "id": pid,
        "article": row["article"],
        "name": row.get("name") or "",
        "collection": row.get("collection") or "",
        "category": row.get("category") or "",
        "designNo": row.get("design_no") or "",
        "quantity": to_number(row.get("quantity_m")),
        "width": to_number(row.get("width_cm")),
        "composition": row.get("composition") or "",
        "colourFamily": row.get("colour_family") or img["colourFamily"],
        "palette": img["palette"],
        "status": (row.get("status") or "available").lower(),
        "featured": str(row.get("featured", "")).lower() in {"1", "yes", "true", "y"},
        "notes": row.get("notes") or "",
        "image": f"images/full/{pid}.webp",
        "thumb": f"images/thumb/{pid}.webp",
        "w": img["w"],
        "h": img["h"],
    }


def build(args: argparse.Namespace) -> None:
    source = Path(args.source)
    if not source.is_dir():
        sys.exit(f"Source folder not found: {source}")
    for d in (FULL_DIR, THUMB_DIR, PRODUCTS_JSON.parent):
        d.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in source.rglob("*") if p.suffix.lower() in IMAGE_EXTS)
    if not files:
        sys.exit("No images found.")
    prefix = slugify(args.collection)
    parser = NAME_PARSERS.get(args.parse_names or "")
    articles = {}
    for f in files:
        meta = parser(f.stem) if parser else {}
        if meta and args.parse_names == "embroidery":  # series code is already part of the article
            article = meta["article"]
            base = f"{prefix}-" + slugify(f"{article} {meta['composition']}")
        elif meta:
            article = meta["article"]
            base = f"{prefix}-" + slugify(f"{article} {meta['design_no']} {meta['composition']}")
        else:
            article = re.sub(r"\s+", "", f.stem).upper()  # "204 A" -> "204A"
            base = f"{prefix}-{article.lower()}"
        pid, n = base, 2
        while pid in articles:  # two photos of the same article
            pid, n = f"{base}-{n}", n + 1
        articles[pid] = (article, str(f), meta)

    print(f"Processing {len(articles)} images with {args.workers} workers ...")
    images = load_previous_products()
    jobs = [(src, pid, args.force) for pid, (_, src, _) in articles.items()]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for i, res in enumerate(pool.map(process_image, jobs, chunksize=2), 1):
            images[res["id"]] = {
                "colourFamily": res["colour_family"], "palette": res["palette"],
                "w": res["w"], "h": res["h"],
            }
            if i % 10 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)}")

    pdf_meta = read_pdf_metadata(Path(args.pdfs) if args.pdfs else None)
    rows = read_catalog_csv()
    for pid, (article, _, meta) in articles.items():
        rows.setdefault(pid, new_csv_row(pid, article, args, pdf_meta, meta))
    write_catalog_csv(list(rows.values()))

    # Every row with a built image becomes a product, so several collections can be merged.
    products = [to_product(row, images[pid]) for pid, row in rows.items() if pid in images]
    products.sort(key=natural_key)
    payload = {"colourFamilies": COLOUR_FAMILIES, "products": products}
    PRODUCTS_JSON.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(products)} products -> {PRODUCTS_JSON.relative_to(ROOT)}")
    print(f"Edit {CATALOG_CSV.relative_to(ROOT)} to add names, widths, compositions, then re-run.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="Folder of raw photos (searched recursively)")
    ap.add_argument("--collection", required=True, help="Collection / supplier name, e.g. CEMB")
    ap.add_argument("--category", default="Lace", help="Fabric category, e.g. Lace, Silk, Embroidery")
    ap.add_argument("--pdfs", help="Folder containing catalogue PDFs to read Design No / Qty from")
    ap.add_argument("--parse-names", choices=sorted(NAME_PARSERS), help="Read article/series/quality/metres from file names")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true", help="Re-encode images that already exist")
    build(ap.parse_args())


if __name__ == "__main__":
    main()
