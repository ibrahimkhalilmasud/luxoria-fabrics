# Luxoria — Couture Fabrics

A luxury showcase for our textile stock. No checkout: clients browse, filter, add fabrics
to a cart and send it to us as a quotation request, by WhatsApp or by email.
The site is static (GitHub Pages, live at https://luxoria.aiqorva.com — DNS is a `luxoria`
CNAME to `ibrahimkhalilmasud.github.io` in the Hostinger zone of aiqorva.com); quotations and prices live in Supabase behind an admin login.

```
site/                       <- everything that goes live
  index.html                <- collection + filters
  showroom.html             <- full-screen scrolling gallery with "+" on every photo
  cart.html                 <- selection, client details, send / request quotation
  admin/index.html          <- private admin (login + authenticator code)
  assets/js/config.js       <- brand, WhatsApp, email, Supabase URL + PUBLIC key
  data/products.json        <- generated, do not edit by hand (contains NO prices)
  images/full|thumb/        <- generated web images
data/catalog.csv            <- master sheet (names, width, composition, status…) — no prices
supabase/schema.sql         <- database tables + security rules
supabase/functions/submit-quote/  <- receives quotations, sends WhatsApp + email alerts
tools/build_catalog.py      <- photos -> web images + products.json
```

## Security model

- **Prices are never in this repository or on the public site.** They are stored only in the
  Supabase `prices` table and are visible only in the admin area.
- Every table has Row Level Security. The public key in `config.js` can read **nothing**.
- Admin access needs: a user you created, listed in `public.admins`, **and** a verified
  authenticator code (MFA, `aal2`). A stolen password alone is not enough.
- Clients can only create quotations through the `submit-quote` function, which validates
  every field, accepts only your site's origin, rate-limits by (hashed) IP and has a spam trap.
- The admin session lives in the browser tab only and signs out after 30 minutes idle.

## One-time setup

### 1. Supabase

1. Create a project at supabase.com (free tier is fine).
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   Keep Email enabled.
4. **Authentication → Users → Add user**: your email + a long unique password (tick "Auto confirm").
5. SQL Editor, make that user an admin:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
6. **Authentication → Multi-Factor**: make sure TOTP (authenticator app) is enabled.
7. Sign in at `https://luxoria.aiqorva.com/admin/` straight away and scan the QR code with your
   authenticator app — the first person to complete this step owns the second factor.

### 2. Alerts

- **WhatsApp (CallMeBot)**: from your phone, send `I allow callmebot to send me messages` to
  the CallMeBot number listed on callmebot.com/blog/free-api-whatsapp-messages. You get an API key.
- **Email (Resend)**: create an account at resend.com → API Keys → create a key.
  Until you verify your own domain, mail is sent from `onboarding@resend.dev` and only to your
  Resend account email.

### 3. Deploy the function

With the Supabase CLI (`npm i -g supabase`, then `supabase login` and `supabase link`):

```bash
supabase secrets set SITE_URL=https://luxoria.aiqorva.com ALLOWED_ORIGINS=https://luxoria.aiqorva.com IP_SALT=<long-random-text> CALLMEBOT_PHONE=<your number with +> CALLMEBOT_APIKEY=<key> RESEND_API_KEY=<key> ADMIN_EMAIL=<you@example.com>
```

```bash
supabase functions deploy submit-quote --no-verify-jwt
```

`SUPABASE_URL` and the service key are provided to the function automatically. Optional:
`RESEND_FROM="Luxoria <quotes@yourdomain.com>"` once your domain is verified in Resend.

### 4. Connect the site

In `site/assets/js/config.js` set `whatsapp`, `email`, `supabaseUrl` and `supabaseKey`
(Project Settings → API → the **anon / publishable** key — never the service / secret key).
Commit and push.

## Add or update fabrics

Needs Python with `pip install pillow pypdf`.

```bash
python tools/build_catalog.py --source "C:/path/to/CEMB" --collection CEMB --category Lace --pdfs "C:/path/to/CEMB Stock"
```

```bash
python tools/build_catalog.py --source "C:/path/to/Silk_In_Stock" --collection Silk --category Silk --parse-names silk
```

```bash
python tools/build_catalog.py --source "C:/path/to/Embroidery Stock" --collection Embroidery --category Embroidery --parse-names embroidery
```

Each photo's ground colour, accent colours and photo quality are read automatically
(`tools/photo_analysis.py`). A colour typed in the `colour_family` column of `data/catalog.csv`
always wins — every photo has been checked by eye and about half were corrected there.
Allowed colours: Black, Grey, Ivory, Beige, Brown, Gold, Orange, Red, Pink, Purple, Blue, Teal,
Green, Multicolour. After editing colours, refresh the site data without the original photos:

```bash
python tools/analyse_photos.py
```

The default order shows the best photographs first (top 30% of each family, then the next 40%,
then the rest), each group in serial-number order; "Serial number" sorting ignores photo quality.

`--parse-names silk` reads article, quality, mill and metres from the silk file names;
`--parse-names embroidery` reads the series code and design number (e.g. `RUSS-51`).
The site always shows Silk first, then Embroidery, then Lace (`CATEGORY_ORDER` in
`tools/build_catalog.py` and `site/assets/js/core.js`). HEIC photos are skipped — save them as JPG.
Collections accumulate. Edit `data/catalog.csv` in Excel for names, width, composition,
status (available / reserved / sold), `colour_family` or `featured` (yes), then run the command again.
Set prices in the admin area, not in the sheet.

## Lookbook, front door and music

The home page opens behind two glass doors; a touch opens them with a burst of light and starts
soft music. The door shows once per visit and is skipped for shared links. The music carries on
from page to page (a page picks up at the same moment; if the browser blocks sound on a new page,
it resumes on the first tap). A floating player bottom-right has play/pause and next track; the
playlist is `TRACKS` in `site/assets/js/music.js` (files in `site/audio/`, AAC ~96 kbps, quiet
mastering around -25 dB mean). Below the hero, **Worn in Luxoria** and the **Lookbook**
page (`lookbook.html`) show models wearing gowns cut from our fabrics; each look opens with the
fabric it is made from, the metres left, add-to-cart and a WhatsApp reserve button.

Rebuild the looks after adding model photos (sources stay outside the repository):

```bash
python tools/build_lookbook.py "<...>/1st 100 Product Sample" "<...>/2nd 100 Product Sample" "<...>/30 CEMB"
```

It takes the `GALIH` model renders and the CEMB palace photos (white-background mock-ups and
swatches are skipped), keeps the 3 best different photos per gown, writes
`site/images/looks/` and `site/data/lookbook.json`, and links each gown to its fabric by code
(`13A-VSS-CDC` → Silk 13 A, design VSS; `231-VDSS` → Embroidery VDSS 231; `11-CEMB-60-SC` → CEMB 11).
Gowns without a catalogue match get an "Ask about this look" WhatsApp button instead.

## Editing fabrics from the admin area

Admin → **Fabrics** lists every piece. Type metres and the price (Malaysian ringgit, RM per metre)
straight into the row and press **Save changes**, or press **Edit** to change the article / serial
number, name, design number, category, metres, width, composition, colour filter, status
(available, reserved, sold, or hidden from the website), signature flag and the public note.
Edits are stored in the Supabase `product_edits` table and show on the website at once — the
photos and `products.json` stay as they are, and **Restore original** removes an edit. Anyone can
read these corrections (they are public catalogue details); only a signed-in admin with the
authenticator code can change them. Prices stay private in the `prices` table.

## Preview locally

```bash
python -m http.server 8420 --directory site
```

Then open http://localhost:8420.

## Size budget

GitHub Pages sites are limited to about 1 GB. Each fabric costs roughly 0.4 MB
(full image + thumbnail), so ~1,700 pieces fit. Beyond that, move `site/images` to a
CDN bucket (e.g. Cloudflare R2) and keep the code here.
