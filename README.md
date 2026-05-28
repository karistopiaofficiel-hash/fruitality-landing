# Fruitality — landing page

Single-file static site. Drop into Netlify, drag onto Cloudflare Pages, or `python3 -m http.server` for local preview.

## Local preview

```bash
cd ~/Desktop/Fruitality/landing-page
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to Netlify (60 seconds)

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag this folder
3. Done. Netlify gives you a `*.netlify.app` subdomain immediately.
4. Want a custom domain? Buy `fruitality.com` (or `.gg`, `.game`) and add it in Netlify → Domain Settings.

## Forms

The email form is wired for **Netlify Forms** (free up to 100 submissions/month). Submissions show in Netlify dashboard → Forms.

To collect more than 100/month, wire it to Mailchimp, ConvertKit, or just a Google Sheet via the form-submit endpoint.

## Update the placeholder fighter cards

When the Higgsfield-generated fighter PNGs land in `~/Desktop/Fruitality/art-references/`:

1. Copy each PNG into `landing-page/assets/` with names: `banana.png`, `pineapple.png`, `kiwi.png`, `coconut.png`
2. In `index.html`, replace each `<div class="fighter fighter--placeholder" id="card-XXX">` with the same structure as the Watermelon card, pointing at the new image
3. Redeploy (re-drag to Netlify)

## CTA links to fill in

Search-replace these placeholders in `index.html`:

- `data-cta="discord"` href → your real Discord invite
- `data-cta="steam"` href → Steam Coming Soon page URL once you've created it
- `data-cta="tiktok"` href → your TikTok profile

Also update `netlify.toml` redirects (`/discord`, `/steam`) if you want short URLs.

## What's NOT here yet (parking lot)

- Real Steam wishlist link (needs Steam Direct $100 first)
- Real Discord invite
- Real App Store / Play pre-register links (post-mobile-alpha)
- Privacy policy + ToS pages (needed before paid UA)
- Analytics (Plausible recommended — open source, $9/mo, GDPR-friendly)
