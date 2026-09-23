# Brand asset production record

## Deliverables

- `web/assets/logo-512.png`: 512 × 512, RGBA PNG, one visible RGB color #F0B90B.
- `web/assets/banner-1500x500.png`: 1500 × 500 PNG, #0B0E11 background, darker hexagonal grid, same logo on the left and a sparse fading row of connected gold dots.

## Method

The built-in image_gen tool was used for the initial logo draft and one cleanup draft (not CLI/API fallback). Both model rasters failed exact size, color and transparency requirements and were discarded from production. The delivered assets are newly drawn mathematical geometry, not cleaned-up model rasters. The original PNG is encoded directly from symmetric supersampled geometry. The banner embeds that exact PNG; Playwright exports the banner SVG at its exact canvas dimensions.

Run `node artifacts/brand-assets/render.mjs` from the project root to reproduce both PNGs, editable SVG sources and the actual-size/circular-crop preview. This uses the existing Playwright installation in `artifacts/site-shots`.

## Final geometric specification

A centered, point-up, closed regular hexagon with six spokes connected to its six vertices and one solid central circular node. Outer vertex radius 180 px on a 512 px canvas; uniform 20 px outline and spokes; center-node radius 27 px. Gold #F0B90B only; alpha edge coverage. The 360 px outer diameter occupies 70.3% of the canvas and fits inside its central 80% circle. Exact horizontal and vertical alpha symmetry. No text, diamond tiles, existing chain logos, gradients, shadows, glows, textures or 3D effects.

Banner: 1500 × 500, background #0B0E11; grid #080B0D. Logo centered at (360,250) using the exact delivered logo PNG at half scale. Seven connected dots diminish in radius, line thickness and opacity from x=480 to x=996. The right half is predominantly empty dark space. No text or extra branding.

## Built-in logo prompt

```text
Use case: logo-brand.
Create ONE final logo asset, exactly 512 x 512 PNG with a genuine transparent alpha background.
A minimal flat vector logo mark for a blockchain project.
Subject: a single CLOSED REGULAR HEXAGON outline, with a solid circular dot exactly at its center and exactly SIX straight spokes connecting the dot to all SIX vertices. Use a point-up regular hexagon, vertical mirror symmetry, horizontal mirror symmetry, with top and bottom vertices. Six spokes must meet the outline cleanly, with no gaps. Simple compass-and-ruler geometry, no extra nodes at the vertices.
Stroke: crisp uniform weight, approximately 18 px at final 512 px size, center dot approximately 52 px diameter. Main symbol outer diameter approximately 358 px, centered precisely on (256,256). Entire artwork must fit comfortably inside the central circle of diameter 410 px, with all corners completely transparent. Preserve large triangular negative spaces between spokes so it is legible at 32 x 32 pixels.
Color: exactly one solid warm gold #F0B90B for every visible stroke and center dot. Alpha antialiasing only at edges. No other colors.
Style: flat vector, 2D, technical equipment stamp, precise and restrained. No background, no tile, no border beyond the hexagon. Truly transparent empty space inside and outside the outline; do not render a checkerboard.
Hard constraints: NO TEXT, letters, numbers, wordmarks or watermarks. No Binance logo, Binance wordmark, BNB Chain logo, four-square diamond arrangement, tilted squares, diamond marks, Ethereum diamonds, Bitcoin B, or any existing blockchain symbols. No mesh gradients, 3D, bevels, glows, shadows, glass, texture or perspective.
Deliver only the centered symbol on transparent background, 512 x 512 PNG.
```

## Built-in cleanup prompt

```text
Edit the provided logo image to meet its original production specification. Keep the overall design: a point-up regular hexagon outline, six straight spokes from its six vertices to one circular center dot, with uniform line weight, precise mirror symmetry.

Fix the problems: REMOVE ALL speckles, mottling, grain, glow and paint-like texture. All six internal triangular openings must be totally empty TRANSPARENT alpha, without a single stray gold fleck. The outer area must be genuine transparent alpha too, not black or checkerboard. Replace the uneven yellow coloring by exactly one flat solid gold #F0B90B, no shades. Sharp clean vector-like geometric edges; no erosion or waviness.

Composition: canvas EXACTLY 512 x 512 pixels. Center on (256,256). The outermost top and bottom tips at y=77 and y=435, giving outer diameter 358px (70% canvas). Hexagon vertices correctly on a circle. Uniform outline and spokes 18px thick; center dot 52px diameter. Generous safe margins survive a circular crop. No additional symbols, no diamond tiles, no text or wordmarks.

Final PNG with clean alpha, one gold color only. This is an extremely minimal pure 2D geometric vector-style logo; NOT a photograph or material.
```

## Banner brief used for the final original vector artwork

```text
A wide minimal banner for a blockchain project's social profile, 1500x500.
Background: a deep near-black neutral (#0B0E11) with a very subtle darker hexagonal grid pattern, barely visible, occupying the full width.
Foreground: the same gold (#F0B90B) hexagon-with-center-node mark, placed on the left third, at a modest size. To its right, a horizontal row of small gold dots connected by thin lines, thinning out and fading toward the right edge — suggesting a network being built outward from nothing.
Style: flat vector, very restrained, mostly empty space. No text, no 3D, no glow, no photographic elements. The right half should be mostly empty dark space.
```

