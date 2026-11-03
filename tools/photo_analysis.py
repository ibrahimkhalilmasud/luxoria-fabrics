"""Read a fabric photo the way a person would: its ground colour, accent colours,
and how good the photograph is.

* Colour is measured in CIELAB (perceptual lightness / chroma / hue), on the
  centre of the photo only, so tables, walls and hands at the edges are ignored.
* The ground colour is the colour family covering most of the fabric; families
  covering at least ACCENT_SHARE of it are kept as accents.
* The photo score rewards sharp, well-exposed, colourful pictures that are not
  clipped to black or white. It is only meaningful when compared within a
  category, which is how the build uses it.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

# Family -> swatch (CSS colour) shown in the filters. Order is the order of the chips.
COLOUR_FAMILIES = {
    "Black": "#141414",
    "Grey": "#9a9a9e",
    "Ivory": "#f1ead9",
    "Beige": "#d6bf9b",
    "Brown": "#6b4a32",
    "Gold": "#d1a630",
    "Orange": "#e0712b",
    "Red": "#b01e2e",
    "Pink": "#e889a6",
    "Purple": "#7a4a9e",
    "Blue": "#2f5fb3",
    "Teal": "#1f8c8f",
    "Green": "#3f8a4e",
    "Multicolour": "conic-gradient(#b01e2e, #d1a630, #3f8a4e, #2f5fb3, #7a4a9e, #b01e2e)",
}
MULTI = "Multicolour"

CENTRE_CROP = 0.12         # ignore this share of the photo on every side
SAMPLE_EDGE = 64           # colour is read on a softened 64 px version
ACCENT_SHARE = 0.12        # a colour needs this much of the fabric to count as an accent
MULTI_GROUND_SHARE = 0.22  # below this no colour leads, and the fabric is "Multicolour"


def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]])
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def classify(L: float, C: float, h: float) -> str:
    """One CIELAB colour (lightness, chroma, hue in degrees) -> colour family."""
    if L < 18:
        return "Black"
    if C < 8:
        return "Ivory" if L > 70 else "Black" if L < 27 else "Grey"
    if C < 14 and L > 70:
        return "Ivory"
    if h >= 330 or h < 15:
        return "Red" if L < 35 else "Pink"
    if h < 48:
        if L >= 68:
            return "Pink"
        if C < 25:
            return "Beige" if L >= 55 else "Brown"
        return "Red"
    if h < 75:
        if C < 22:
            return "Beige" if L >= 58 else "Brown"
        if L < 50:
            return "Brown"
        return "Beige" if L >= 78 and C < 35 else "Orange"
    if h < 105:
        if C < 20:
            return "Beige" if L >= 55 else "Brown"
        return "Brown" if L < 45 else "Gold"
    if C < 10:
        return "Grey"
    if h < 175:
        return "Green"
    if h < 240:
        return "Teal"
    if h < 305:
        return "Blue"
    return "Pink" if L >= 58 and C >= 40 else "Purple"


def _centre(im: Image.Image) -> Image.Image:
    w, h = im.size
    dx, dy = round(w * CENTRE_CROP), round(h * CENTRE_CROP)
    return im.crop((dx, dy, w - dx, h - dy))


def colour_shares(im: Image.Image) -> dict[str, float]:
    """Share of the fabric (0-1) covered by each colour family, largest first."""
    small = _centre(im.convert("RGB")).filter(ImageFilter.GaussianBlur(3))
    small.thumbnail((SAMPLE_EDGE, SAMPLE_EDGE), Image.Resampling.BOX)
    lab = _srgb_to_lab(np.asarray(small, dtype=np.float64).reshape(-1, 3))
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    hue = np.degrees(np.arctan2(lab[:, 2], lab[:, 1])) % 360
    counts: dict[str, int] = {}
    for fam in map(classify, lab[:, 0], chroma, hue):
        counts[fam] = counts.get(fam, 0) + 1
    total = sum(counts.values())
    return dict(sorted(((k, v / total) for k, v in counts.items()), key=lambda kv: -kv[1]))


def colours_of(im: Image.Image) -> tuple[str, list[str]]:
    """(ground colour family, accent families)."""
    ranked = list(colour_shares(im).items())
    ground, top = ranked[0]
    if top < MULTI_GROUND_SHARE:
        return MULTI, [f for f, _ in ranked[:3]]
    return ground, [f for f, s in ranked[1:] if s >= ACCENT_SHARE][:3]


def palette_of(im: Image.Image, n: int = 4) -> list[str]:
    small = _centre(im.convert("RGB"))
    small.thumbnail((160, 160))
    quant = small.quantize(colors=6, method=Image.Quantize.MEDIANCUT)
    pal = quant.getpalette()
    counts = sorted(quant.getcolors(), reverse=True)
    return ["#%02x%02x%02x" % tuple(pal[i * 3: i * 3 + 3]) for _, i in counts[:n]]


def photo_score(im: Image.Image) -> float:
    """Higher is a nicer photograph: sharp, well exposed, colourful, not clipped."""
    work = im.convert("RGB")
    work.thumbnail((480, 480), Image.Resampling.LANCZOS)
    rgb = np.asarray(work, dtype=np.float64)
    grey = rgb @ np.array([0.299, 0.587, 0.114])
    lap = grey[1:-1, 1:-1] * 4 - grey[:-2, 1:-1] - grey[2:, 1:-1] - grey[1:-1, :-2] - grey[1:-1, 2:]
    sharpness = np.log1p(lap.var())
    rg = rgb[..., 0] - rgb[..., 1]
    yb = (rgb[..., 0] + rgb[..., 1]) / 2 - rgb[..., 2]
    colourful = np.hypot(rg.std(), yb.std()) + 0.3 * np.hypot(rg.mean(), yb.mean())
    exposure = 1 - min(1.0, abs(grey.mean() / 255 - 0.52) / 0.4)
    clipped = ((grey < 8) | (grey > 248)).mean()
    contrast = min(grey.std() / 64, 1.2)
    return round(float(sharpness + colourful / 40 + exposure * 1.5 + contrast - clipped * 4), 3)


# Within each category, the best GRADE_SHARES[0] of photos get grade 1, the next share grade 2,
# the rest grade 3. The site shows grade 1 first, each grade in serial-number order.
GRADE_SHARES = (0.3, 0.4)


def grades_by_category(products: list[dict]) -> dict[str, int]:
    """id -> 1 (best photos), 2 or 3, ranked on photoScore within each category."""
    grades: dict[str, int] = {}
    by_cat: dict[str, list[dict]] = {}
    for p in products:
        by_cat.setdefault(p.get("category", ""), []).append(p)
    for items in by_cat.values():
        ranked = sorted(items, key=lambda p: -(p.get("photoScore") or 0))
        first = round(len(ranked) * GRADE_SHARES[0])
        second = first + round(len(ranked) * GRADE_SHARES[1])
        for i, p in enumerate(ranked):
            grades[p["id"]] = 1 if i < first else 2 if i < second else 3
    return grades


def analyse(im: Image.Image) -> dict:
    ground, accents = colours_of(im)
    return {"colourFamily": ground, "accents": accents, "palette": palette_of(im), "score": photo_score(im)}
