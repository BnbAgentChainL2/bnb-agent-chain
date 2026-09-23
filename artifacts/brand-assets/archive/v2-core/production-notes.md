# Selected AI Agent identity

The user rejected the original hexagonal network mark and selected the Core face (second of three built-in image_gen concepts): no antenna, a central forehead sensor and two calm horizontal eyes.

## Delivered assets

- web/assets/logo-512.png: 512 × 512 RGBA PNG, genuine transparency, exact #F0B90B on every visible pixel.
- web/assets/banner-1500x500.png: 1500 × 500 PNG; dark #0B0E11 background, subtle darker hexagonal grid, the same face on the left and a diminishing row of connected gold dots.

The selected concept was redrawn as clean original SVG geometry for the final export. The jaw transitions were simplified to reduce the deep cheek notches; the forehead dot, visor and horizontal eyes were preserved. No text, gradients, glow, texture, shadows, existing chain symbols or official Binance/BNB shapes appear in the assets. The logo has exact horizontal alpha symmetry, and its silhouette fits inside the central 80% circle.

## Reproduction and source

Run `node artifacts/brand-assets/render.mjs` from the project root. The entry point imports render-agent.mjs and uses the existing Playwright installation in artifacts/site-shots. It renders the SVG at 4× resolution, samples alpha, enforces bilateral edge symmetry and directly encodes the exact gold RGBA PNG. The banner embeds that delivered PNG and is exported at 1500 × 500.

- logo.svg and banner.svg: final vector sources.
- preview.html and preview.png: actual-size dark/light previews at 32, 48 and 96 px, circular crop and banner.
- agent-face-study/prompts.md: exact prompts used with the built-in image_gen tool (no CLI/API fallback).
- agent-face-study/core-model-draft.png: the model concept selected by the user; a draft, not the final production asset.
- archive/v1-hexagon/: previous assets and their original generation records, retained for history.
