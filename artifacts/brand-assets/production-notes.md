# Agent Companion identity

The user requested a redesign referencing Binance's official BiBi AI character. The final mark uses upright pill eyes and a simple smile inside an original rounded six-sided silhouette. It succeeds the mechanical Core face and the original network-wheel concept.

## Deliverables

- web/assets/logo-512.png — 512 × 512 RGBA PNG; #F0B90B is the only visible RGB color; eyes and mouth are genuine transparent cutouts.
- web/assets/banner-1500x500.png — 1500 × 500 PNG; pale #F8F9FA background, navy #081D35 AGENT CHAIN title and deeper gold BNB, with the unchanged mascot in a sparse blue/gold network on the right.

The logo mark is closed, horizontally symmetrical and contained inside the central 80% circle. The logo contains no text. The user subsequently requested BNB AGENT CHAIN text in the banner; this explicitly supersedes the original no-text banner brief. Neither asset contains a diamond arrangement, official chain logo, texture, gradient, glow or shadow. Zero-alpha pixels have zero RGB to support transparent previews cleanly.

Banner typography: Arial Bold, an oversized 86px gold BNB above a 96px navy AGENT CHAIN title. The new composition matches the explorer's bright cards and navy/gold branding; a compact network surrounds the original logo on the right. The earlier dark banner is retained in archive/v4-banner-dark. Details and profile-overlap preview are in banner-README.md and banner-preview.png.

## Process and references

Official BiBi reference: https://www.binance.com/en/square/profile/bibi

The built-in image_gen tool was used for the reference-guided concept. The production art was then drawn as original SVG geometry and exported precisely. No CLI/API fallback was used. Exact tool prompt, official reference image URLs and the reasoning behind the changes are in bibi-reference/reference-and-prompt.md. The downloaded official images and model-concept.png are reference/draft files only.

## Reproduction

Run `node artifacts/brand-assets/render.mjs` from the project root. It imports render-agent.mjs, then render-banner.mjs, and uses the existing Playwright installation in artifacts/site-shots. The logo is rendered at 4×, alpha is downsampled, left/right edge coverage is made symmetrical and the PNG encoder writes the exact gold color. The banner embeds the final logo PNG. To update only the banner, run `node artifacts/brand-assets/render-banner.mjs`.

Final vector sources: logo.svg and banner.svg.
Review: preview.html and preview.png include 32/48/96px dark/light backgrounds and circular crop checks.
Earlier versions are preserved under archive/v1-hexagon and archive/v2-core.
