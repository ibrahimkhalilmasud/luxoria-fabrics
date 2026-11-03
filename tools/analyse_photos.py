"""Re-read colour and photo quality for every fabric already on the site.

Works from the published images (site/images/full), so the original photo
folders are not needed. Colours you set by hand in data/catalog.csv
(colour_family column) always win over the automatic reading.

Usage:
  python tools/analyse_photos.py
"""

from __future__ import annotations

import json
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

from build_catalog import PRODUCTS_JSON, SITE, read_catalog_csv
from photo_analysis import COLOUR_FAMILIES, analyse, grades_by_category


def _analyse(job: tuple[str, str]) -> tuple[str, dict]:
    pid, path = job
    with Image.open(path) as im:
        return pid, analyse(im)


def main() -> None:
    data = json.loads(PRODUCTS_JSON.read_text(encoding="utf-8"))
    products = data["products"]
    rows = read_catalog_csv()
    jobs = [(p["id"], str(SITE / p["image"])) for p in products]
    with ProcessPoolExecutor() as pool:
        found = dict(pool.map(_analyse, jobs, chunksize=8))

    updated = []
    for p in products:
        auto = found[p["id"]]
        colour = (rows.get(p["id"], {}).get("colour_family") or "").strip() or auto["colourFamily"]
        if colour not in COLOUR_FAMILIES:
            raise SystemExit(f'{p["id"]}: unknown colour "{colour}" in data/catalog.csv')
        updated.append({
            **p,
            "colourFamily": colour,
            "accents": [c for c in auto["accents"] if c != colour],
            "palette": auto["palette"],
            "photoScore": auto["score"],
        })
    grades = grades_by_category(updated)
    payload = {**data, "colourFamilies": COLOUR_FAMILIES,
               "products": [{**p, "grade": grades[p["id"]]} for p in updated]}
    PRODUCTS_JSON.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Updated colours and photo grades for {len(updated)} fabrics.")


if __name__ == "__main__":
    main()
