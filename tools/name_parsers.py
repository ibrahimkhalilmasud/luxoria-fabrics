"""Turn structured stock photo file names into catalogue fields.

Silk names look like "02 A-VSS- CDC TESI-5.0": article, series code, quality, mill, metres.
"""

from __future__ import annotations

import re

QUALITY_FIXES = {
    "GEPRGETTE": "GEORGETTE", "GEORGETTER": "GEORGETTE", "GEORGEETE": "GEORGETTE",
    "CHEFFON": "CHIFFON", "JACAURD": "JACQUARD", "JACQURD": "JACQUARD",
    "POINTED": "PRINTED", "TWILLCDC": "TWILL CDC",
}
QUALITY_NAMES = {
    "CDC": "Crêpe de Chine", "TWILL CDC": "Twill Crêpe de Chine",
    "LUREX ON CHIFFON DELUX": "Lurex on Chiffon Deluxe",
}
MILLS = {"TESSI": "Tessi", "TESI": "Tessi", "QUO": "Quo", "SETE": "Sete", "SILKO": "Silko"}
NOISE = {"NC", "THIS", "IS", "THE", "REAL", "PIC"}
SERIES = re.compile(r"^[A-Z]{3,4}$")


def parse_silk_name(stem: str) -> dict:
    text = stem.upper().replace("_", " ")
    qty = None
    m = re.search(r"-\s*(\d+(?:\.\d+)?)\s*$", text) or re.search(r"\s(\d+(?:\.\d+)?)\s*(?:MT)?\s*$", text)
    if m:
        qty = float(m.group(1))
        text = text[: m.start()]
    text = re.sub(r"\(\d+\)", " ", text).strip(" -.")

    art = re.match(r"^\s*(\d+)\s*([A-Z])?(?=[\s-]|$)", text)
    article, rest = "", text
    if art:
        article = art.group(1) + (f" {art.group(2)}" if art.group(2) else "")
        rest = text[art.end():]

    tokens = [t for t in re.split(r"[\s-]+", rest) if t]
    series = next((t for t in tokens if SERIES.match(t) and t not in MILLS and t not in NOISE
                   and t not in {"CDC", "SATIN", "CADY"}), "")
    if not article:  # e.g. "ISS-987 (2) CDC" -> article after the series code
        num = next((t for t in tokens if t.isdigit()), "")
        article = num
        tokens = [t for t in tokens if t != num]
    mills = [MILLS[t] for t in tokens if t in MILLS]
    words = [QUALITY_FIXES.get(t, t) for t in tokens if t != series and t not in MILLS and t not in NOISE]
    quality = " ".join(words).strip()
    quality = QUALITY_NAMES.get(quality, quality.title().replace("Cdc", "Crêpe de Chine"))
    return {
        "article": article or stem.strip(),
        "design_no": series,
        "quantity_m": qty if qty is not None else "",
        "composition": quality,
        "notes": f"Mill: {mills[0]}" if mills else "",
    }
