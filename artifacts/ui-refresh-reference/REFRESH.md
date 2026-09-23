# Explorer and banner refresh

The explorer now uses slate gray surroundings (#E4E8EB), pearl gray data cards (#F4F6F7), blue links, a graphite blue introduction (#192E38) and restrained gold branding. The accepted Companion logo replaces the previous placeholder marks. Recent blocks and transactions precede secondary protocol panels; mobile avoids duplicating the chain-head card above the same metric strip.

## Background and typography follow-up

- Replaced the full hero grid and concentric rings with sparse network traces; toned down white across the header, cards, table headings and footer bar.
- Numeric indicators use tabular Segoe UI / system sans numerals. Hashes and code retain monospace. Chinese text prefers Noto Sans SC with PingFang / Microsoft YaHei fallbacks; no remote font dependency was added.
- Gas is labeled “当前 Gas”; main readings use 24px on desktop and 20px on mobile, with 12px units and descriptions. Panel labels and secondary readings also use a consistent larger scale.
- The existing 36-page route/responsive check passed at 390, 1440 and 1920px. Additional overview checks at 320, 360, 768, 1024 and 1440px found no page overflow or clipped main readings; sampled body/metric labels met 4.5:1 contrast.
- Chrome's actual font report confirmed Segoe UI Variable for the Gas value, Segoe UI for its 12px unit and Noto Sans SC for Chinese labels. Live RPC screenshots are `graphite-desktop-live-top.png`, `graphite-mobile-live-top.png`, and the `graphite-*-metrics.png` / `graphite-*-panels.png` crops. Files without `live` in the initial full-page graphite captures use explicitly marked demo data.

## Agent signal animation

- The hero's decorative inline SVG now connects small Agent faces with gold and cyan signal trails. Receiving nodes briefly emit an expanding ring; paths are sparse around the title and remain behind solid data panels.
- Mobile retains one moving signal and fades the network toward the text. `prefers-reduced-motion` shows a static network. Signals run automatically; there is no on-page animation control.
- `web/js/ui/hero-signals.js` only manages animation play state: it pauses outside the viewport or when the document is hidden. There is no render loop, dependency, network request or connection to live Agent activity.
- Live-data review images: `signals-desktop-live-top.png`, `signals-mobile-live-top.png`, `signals-desktop-hero.png`, `signals-mobile-hero.png`.

## Changed source

- `web/css/scan-theme.css`: shared light palette, readable text, cards, tables, navigation, responsive layout and navy hero decoration.
- `web/index.html`: stylesheet, logo/favicon references, shorter introduction, overview ordering and brand assets. Existing binding IDs, search controls and routes are retained.
- `web/assets/banner-1500x500.png`: new light banner with navy/gold typography and a restrained network illustration.
- `artifacts/brand-assets/render-banner.mjs`: reproducible banner source; full identity renderer delegates to this file.

Data access, routing, search and metric bindings were not changed. The standalone hero script only controls decorative animation. No new prices, counts or charts were invented.

## Primary visual references

- https://bscscan.com/assets/css/theme.min.css
- https://bscscan.com/assets/bsc/css/bscscan.min.css?v=26.9.3.0

BscScan's homepage returned a Cloudflare 403. `bscscan-official-css-reference.png` is a local reference board rendered from verified official stylesheet values, not a screenshot of the homepage.

## Validation

- Existing `chk-exchange-skin.mjs`: 12 routes at 390, 1440 and 1920px passed.
- Additional `verify-ui-refresh.mjs`: 33 pages including tokens, pairs and swaps; navigation and block search passed. No JavaScript errors, page overflow or clipped titles.
- Final small-text checks: deployment label 5.05:1, transfer label 5.26:1, footer 5.17:1. Sampled body, headings and labels meet 4.5:1.
- A non-demo run read the real RPC with matching view-model/DOM head numbers, 20 blocks loaded and 14 overview rows. Final screenshots are `after-desktop-live-top.png`, `after-mobile-live-top.png` and their full-page counterparts.
- Banner remains 1500 × 500; logo SHA-256 remains `66b16836d645d66fb8862497c6e35490c1be2d69faeecf1660d0cf5fa23f580b`.

## Review and deployment

Local live-data preview: http://127.0.0.1:4187/#/overview

Restart it with `node artifacts/ui-refresh-reference/serve-preview.mjs`.

The production domain has not been replaced. Vercel preview deployment was attempted, but the current login cannot retrieve the linked `bnb-agent-chain` project. Explicit project inspection in the accessible team also reports that the project is unavailable. No project link, account, production alias or other site's deployment was changed. Publishing requires access to the existing project's Vercel account/team.
