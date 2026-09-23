# BiBi visual reference and logo revision

## Verified primary references

- Officially verified Binance BiBi profile: https://www.binance.com/en/square/profile/bibi
- Official profile avatar: https://bin.bnbstatic.com/static/content/live-admin-api/images/eAnmgHqKiidT6f7JHuNPgi.png
- Official BinanceCIS launch post: https://www.binance.com/en/square/post/32908262668402
- Image from that official launch post: https://public.bnbstatic.com/static/content/square/images/f6b036f78b9d4c32b48640772f04a6f5.jpg

Downloaded official images are reference material only. They are not the delivered project logo or banner. Unofficial BIBI token sites were not used as authority for the identity.

## Design decision

The user asked to reference BiBi after selecting the previous Core robot face. The revision uses simple upright eyes, a small smile and a generous flat gold mass. The outer shape is an original rounded, flat-top six-sided figure. The design retains the user's original restrictions against official Binance logos, diamond/tiled-square motifs, text, gradients, glow and tiny details. The face's eye and mouth shapes are transparent negative space so the PNG remains single-color.

The built-in image_gen tool produced the concept from the official avatar and the previous project preview. The final original SVG was drawn from that concept and exported with exact color, geometry and dimensions. No CLI/API fallback was used.

## Exact built-in image_gen prompt

```text
Create ONE new original production logo for BNB AGENT CHAIN, an independent AI-agent blockchain. The project name is context only: DO NOT draw any text.

REFERENCE 1 is the official BiBi avatar. Learn ONLY its cheerful personality, simple upright pill eyes, tiny open smile, compact facial spacing and generous solid yellow mass. Do NOT copy its rotated-square/diamond silhouette, sparkle, gradients or brand identity.
REFERENCE 2 is our previous AI-head preview. Replace the mechanical visor, forehead dot, helmet chin and narrow horizontal eyes with the simpler friendly expression described above. Ignore ALL typography, multiple sizes and banner layout in reference 2.

NEW ORIGINAL MARK: a single solid soft HEXAGON character, a SIX-SIDED regular flat-top hexagon with six broad rounded corners, flat horizontal top and bottom edges and equally sized diagonal shoulder edges. It has a pleasing full compact shape, wider than tall, with no outline frame and no border. NOT a diamond, NOT a square on a corner, NOT a helmet. The center is a simple friendly face: exactly two matching vertical rounded pill eyes and one tiny calm open semicircular smile, all punched out as genuine transparent holes. Facial group is centered horizontally and a little above the vertical midpoint. The entire mark is strictly bilaterally symmetrical. It should feel like an intelligent, approachable autonomous companion with a quiet confident expression. No antenna, no third forehead eye, no eyebrows, no ears, no nose, no limbs or decoration.

Color: ONE uniform solid gold #F0B90B. All empty space including the eyes and smile is actual transparent alpha. No black ink, no white ink, no secondary color. NO gradients, shading, soft light, shiny materials, glow, blur, drop shadow, texture, bevel, 3D or photographic surface. This is clean flat vector artwork like a masterfully reduced classic brand icon.
Composition: single mark centered on a 512 x 512 PNG canvas. Width about 350 px and height about 310 px, entirely inside the center 80% circle. Clearly identifiable at 32 x 32. Eyes and mouth must remain readable at this size.
NO letters, numbers, words, wordmarks, Binance logo, BNB logo, four-square diamond arrangements, tilted squares, Ethereum marks, Bitcoin symbols or existing chain emblems.
Output ONLY one centered icon on actual transparent background, not a design sheet, no captions or explanatory text.
```

