"""Build the Lookbook: model photos of dresses made from Luxoria fabrics.

Reads the video-catalogue folders (kept outside the repository), picks the best
few model photos per dress, writes web-sized WebP files to site/images/looks/ and
site/data/lookbook.json, and links each dress to its fabric(s) in the catalogue.

    python tools/build_lookbook.py "<...>/1st 100 Product Sample" "<...>/2nd 100 Product Sample" "<...>/30 CEMB"
    python tools/build_lookbook.py --relink     # only refresh the fabric links
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
from photo_analysis import photo_score  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT_DIR = SITE / "images" / "looks"
OUT_JSON = SITE / "data" / "lookbook.json"

FULL_H = 1100          # px, the photo shown full screen
THUMB_H = 560          # px, cards and strips
PHOTOS_PER_LOOK = 3
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
SKIP_DIRS = {"video", "pdf"}
WHITE_BORDER_MAX = 0.45  # flat mock-ups sit on white; model photos do not
NEAR_DUPLICATE = 6       # dHash bits

COLLECTIONS = {  # folder word -> (collection shown on the site, catalogue category)
    "BEIRUT": ("Beirut Lace", "Lace"),
    "EMBROIDERY": ("Embroidery", "Embroidery"),
    "SILK": ("Silk", "Silk"),
    "CEMB": ("Couture Lace", "Lace"),
}
COLLECTION_ORDER = ["Silk", "Embroidery", "Couture Lace", "Beirut Lace"]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def collection_of(path: Path) -> tuple[str, str] | None:
    for part in path.parts:
        for word, info in COLLECTIONS.items():
            if word in part.upper():
                return info
    return None


def find_looks(roots: list[Path]) -> dict[str, dict]:
    """Dress code -> {collection, category, files}. GALIH folders hold the model renders;
    the CEMB folders hold palace shots next to flat mock-ups and fabric swatches."""
    looks: dict[str, dict] = {}
    for root in roots:
        for galih in root.rglob("GALIH"):
            code = galih.parent.name.strip()
            info = collection_of(galih.relative_to(root))
            if info:
                looks.setdefault(code, {"collection": info[0], "category": info[1], "files": []})["files"] += [
                    f for f in galih.iterdir() if f.suffix.lower() in IMAGE_EXT]
        for code_dir in root.glob("*/*CEMB*"):
            if not code_dir.is_dir() or not re.match(r"^\d+\s*-\s*CEMB", code_dir.name):
                continue
            # Files named after the code ("48-CEMB-60-SC.jpg") are fabric swatches, not model photos.
            files = [f for f in code_dir.rglob("*") if f.suffix.lower() in IMAGE_EXT and "CEMB" not in f.stem.upper()
                     and not SKIP_DIRS & {p.lower() for p in f.relative_to(code_dir).parts[:-1]}]
            code = re.sub(r"\s+", "", code_dir.name)
            looks.setdefault(code, {"collection": "Couture Lace", "category": "Lace", "files": []})["files"] += files
    return looks


def is_model_photo(im: Image.Image) -> bool:
    w, h = im.size
    if h < w * 1.15:  # fabric swatches and composites are landscape or square
        return False
    small = np.asarray(im.convert("L").resize((60, 90)), dtype=np.int16)
    border = np.concatenate([small[:4].ravel(), small[-4:].ravel(), small[:, :4].ravel(), small[:, -4:].ravel()])
    return (border > 240).mean() < WHITE_BORDER_MAX


def dhash(im: Image.Image) -> int:
    px = np.asarray(im.convert("L").resize((9, 8)), dtype=np.int16)
    return int("".join("1" if b else "0" for b in (px[:, 1:] > px[:, :-1]).ravel()), 2)


def best_photos(files: list[Path]) -> list[tuple[Path, Image.Image]]:
    scored = []
    for f in sorted(set(files)):
        try:
            im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        except OSError as err:
            print(f"  skip {f.name}: {err}")
            continue
        if is_model_photo(im):
            scored.append((photo_score(im), f, im))
    scored.sort(key=lambda t: -t[0])
    picked, hashes = [], []
    for _, f, im in scored:
        h = dhash(im)
        if any(bin(h ^ o).count("1") <= NEAR_DUPLICATE for o in hashes):
            continue
        picked.append((f, im))
        hashes.append(h)
        if len(picked) == PHOTOS_PER_LOOK:
            break
    return picked


def save(im: Image.Image, height: int, path: Path, quality: int) -> tuple[int, int]:
    w, h = im.size
    out = im.resize((round(w * height / h), height), Image.Resampling.LANCZOS) if h > height else im
    out.save(path, "WEBP", quality=quality, method=6)
    return out.size


def fabric_ids(code: str, category: str, products: list[dict]) -> list[str]:
    """Catalogue ids of the fabric a dress is made from, or [] when not certain."""
    code = re.sub(r"[^A-Z0-9]+$", "", code.upper())
    ids = {p["id"] for p in products}
    if m := re.match(r"^(\d+)-CEMB", code):
        return [f"cemb-{m[1]}"] if f"cemb-{m[1]}" in ids else []
    if category == "Embroidery":
        m = re.match(r"^(\d+)-([A-Z]+)$", code) or re.match(r"^([A-Z]+)-(\d+)$", code)
        if not m:
            return []
        num, design = (m[1], m[2]) if m[1].isdigit() else (m[2], m[1])
        for d in (design, re.sub(r"S{3,}$", "SS", design)):  # "UUSSS" is a typo for "UUSS"
            found = [p["id"] for p in products if p["article"] == f"Embroidery {d} {num}"]
            if found:
                return found
        return []
    m = re.match(r"^(\d+)\s*([A-Z])?-([A-Z]+)", code)
    if not m or category != "Silk":
        return []
    num, letter, design = m[1], m[2], m[3]
    if letter:
        return [p["id"] for p in products if p["article"] == f"Silk {num} {letter}" and p["designNo"] == design]
    exact = [p["id"] for p in products if p["article"] == f"Silk {num}" and p["designNo"] == design]
    if exact:
        return exact
    # No letter in the folder name: accept "Silk 52 A" only when one lettered article has that design.
    near = [p for p in products if re.fullmatch(rf"Silk {num} [A-Z]", p["article"]) and p["designNo"] == design]
    return [p["id"] for p in near] if len({p["article"] for p in near}) == 1 else []


def code_key(code: str) -> tuple:
    m = re.match(r"(\d+)", code)
    return (int(m[1]) if m else 0, code)


def relink(products: list[dict]) -> None:
    """Refresh only the fabric links in lookbook.json (after catalogue changes), keeping the photos."""
    data = json.loads(OUT_JSON.read_text(encoding="utf-8"))
    for look in data["looks"]:
        look["fabrics"] = fabric_ids(look["code"], look["category"], products)
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{sum(bool(l['fabrics']) for l in data['looks'])} of {len(data['looks'])} looks linked to catalogue fabrics")


def main(argv: list[str]) -> None:
    if argv == ["--relink"]:
        relink(json.loads((SITE / "data" / "products.json").read_text(encoding="utf-8"))["products"])
        return
    only = ""
    if argv and argv[0].startswith("--only="):  # rebuild just the codes containing this text
        only, argv = argv[0].split("=", 1)[1].upper(), argv[1:]
    roots = [Path(a) for a in argv]
    if not roots or not all(r.is_dir() for r in roots):
        sys.exit(__doc__)
    products = json.loads((SITE / "data" / "products.json").read_text(encoding="utf-8"))["products"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    found = {c: v for c, v in find_looks(roots).items() if only in c.upper()}
    keep = [l for l in json.loads(OUT_JSON.read_text(encoding="utf-8"))["looks"] if l["code"] not in found] if only else []
    for old in OUT_DIR.glob("*.webp"):
        if not only or any(old.name.startswith(f"{slug(c)}-") for c in found):
            old.unlink()

    looks, matched = list(keep), sum(bool(l["fabrics"]) for l in keep)
    for code in sorted(found, key=code_key):
        info = found[code]
        photos = best_photos(info["files"])
        if not photos:
            print(f"  no model photo for {code}")
            continue
        lid = slug(code)
        entries = []
        for i, (_, im) in enumerate(photos, 1):
            fw, fh = save(im, FULL_H, OUT_DIR / f"{lid}-{i}.webp", 74)
            save(im, THUMB_H, OUT_DIR / f"{lid}-{i}-t.webp", 70)
            entries.append({"src": f"images/looks/{lid}-{i}.webp", "thumb": f"images/looks/{lid}-{i}-t.webp", "w": fw, "h": fh})
        fabrics = fabric_ids(code, info["category"], products)
        matched += bool(fabrics)
        looks.append({"id": lid, "code": code, "collection": info["collection"], "category": info["category"],
                      "score": round(photo_score(photos[0][1]), 3), "photos": entries, "fabrics": fabrics})
        print(f"{code:28} {len(entries)} photos  fabrics: {len(fabrics)}")

    looks.sort(key=lambda l: (COLLECTION_ORDER.index(l["collection"]), code_key(l["code"])))
    OUT_JSON.write_text(json.dumps({"collections": COLLECTION_ORDER, "looks": looks}, ensure_ascii=False, indent=1),
                        encoding="utf-8")
    size = sum(f.stat().st_size for f in OUT_DIR.glob("*.webp")) / 1e6
    print(f"\n{len(looks)} looks, {matched} linked to catalogue fabrics, {size:.1f} MB of photos")


if __name__ == "__main__":
    main(sys.argv[1:])
