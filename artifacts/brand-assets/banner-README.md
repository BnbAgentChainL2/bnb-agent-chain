# Banner refresh — September 23, 2026

The refreshed 1500 × 500 banner matches the explorer's light presentation: near-white `#F8F9FA`, BscScan-inspired navy `#081D35`, brand gold `#F0B90B`, and a small amount of blue `#0784C3`. The oversized name stays legible when the cover is displayed at 600 × 200. The gold lettering uses a slightly deeper `#DBA509` for clarity on the pale background.

The accepted Agent Companion PNG is embedded unchanged. Its navy backing and restrained network diagram sit at the right, leaving the lower-left profile-avatar overlap free of important content. No Binance or BNB Chain mark appears.

- Final asset: `web/assets/banner-1500x500.png`
- Editable composition: `artifacts/brand-assets/banner.svg`
- Profile and compact preview: `artifacts/brand-assets/banner-preview.png`
- Previous dark banner: `artifacts/brand-assets/archive/v4-banner-dark/`

Recreate from the repository root:

```powershell
node artifacts/brand-assets/render-banner.mjs
```

This renderer reads `web/assets/logo-512.png` but never writes it. It uses the existing Playwright installation in `artifacts/site-shots/node_modules`. Arial Bold is installed on this workstation; Liberation Sans is the fallback. The full identity renderer now delegates the banner stage to this file, so either entry point preserves the new composition.

Verified: PNG IHDR is exactly 1500 × 500; original logo SHA-256 stays `66b16836d645d66fb8862497c6e35490c1be2d69faeecf1660d0cf5fa23f580b`; full-size and profile-crop previews inspected visually.
