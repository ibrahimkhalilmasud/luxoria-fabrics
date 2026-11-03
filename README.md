# Luxoria — Couture Fabrics

A luxury, static showcase for our textile stock. No checkout: clients browse, filter,
build a selection and send it to us by WhatsApp or email. Hosted free on GitHub Pages.

```
site/                 <- everything that goes live
  index.html
  assets/css/style.css
  assets/js/config.js <- brand, WhatsApp number, email, price toggle settings
  assets/js/app.js
  data/products.json  <- generated, do not edit by hand
  images/full|thumb/  <- generated web images
data/catalog.csv      <- YOUR master sheet (names, prices, width, composition, status…)
tools/build_catalog.py
```

## Add or update fabrics

1. Put the raw photos in a folder (any size, JPG/PNG). The file name becomes the article number.
2. Run (needs Python with `pip install pillow pypdf`):

   ```bash
   python tools/build_catalog.py --source "C:/path/to/photos" --collection CEMB --category Lace --pdfs "C:/path/to/catalogue-pdfs"
   ```

   Use a different `--collection` / `--category` for each supplier or fabric type
   (e.g. `--collection BEIRUT --category Lace`, `--category Silk`). Collections accumulate.
3. Open `data/catalog.csv` in Excel and fill in whatever you like:
   `name, width_cm, composition, colour_family, price, currency, status (available/reserved/sold), featured (yes)`.
   Run the command again to apply the changes.
4. Commit and push — the site redeploys automatically in about a minute.

## Prices

Prices are hidden by default. In `site/assets/js/config.js`:

- `allowPriceToggle: true` shows the "Prices" switch in the header.
- `showPricesByDefault: false` keeps them hidden until a visitor switches them on.
- Pieces without a price show "Price on request".

## Contact details

Set `whatsapp` (digits only, with country code) and `email` in `site/assets/js/config.js`.

## Preview locally

```bash
python -m http.server 8420 --directory site
```

Then open http://localhost:8420.

## Size budget

GitHub Pages sites are limited to about 1 GB. Each fabric costs roughly 0.5 MB
(full image + thumbnail), so ~1,700 pieces fit. If the archive grows much beyond
that, move `site/images` to a CDN bucket (e.g. Cloudflare R2) and keep the code here.
