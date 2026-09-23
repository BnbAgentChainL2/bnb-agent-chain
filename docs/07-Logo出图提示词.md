# 07 · Logo 出图提示词（给 Codex / 图像模型）

用途：flap.sh 发射表单的代币 logo、X 头像、网站 favicon。三处用同一张图，所以必须在 **32×32 缩到极小时仍然认得出**。

交付：**512×512 PNG，透明底**（flap.sh 和 X 都会把它裁成圆形，所以主体要在中心 80% 的圆内，四角留空）。
另外要一张 **1500×500 PNG** 作 X 的横幅。

---

## 硬约束（违反其中任何一条都不能用）

1. **不得出现 Binance 的标志、字标、或那个菱形四块图案的任何变体。** 本项目与 Binance、BNB Chain 官方无关，logo 像官方标志会构成误导，这是红线。
2. 不要写任何文字（"BAC"、"BNB" 都不要）。32×32 下文字必然糊掉，而且带文字的 logo 在 DEX 列表里最难认。
3. 不要渐变网格、不要玻璃拟物、不要 3D 渲染质感、不要光晕堆叠——这些在小尺寸下会变成一坨。
4. 不要用现成的以太坊菱形、比特币 B、或任何已有公链的符号。
5. 形状必须**闭合、对称、边界清晰**，缩到 32px 后轮廓不能碎。

---

## 提示词（英文，直接喂给模型）

```
A minimal flat vector logo mark for a blockchain project, on a fully transparent background.

Subject: a single hexagon outline with a solid dot at its center and six short straight
lines radiating from the center dot to each vertex of the hexagon — like a node connected
to six peers. Geometric, perfectly symmetrical, drawn with a compass-and-ruler precision.

Style: flat vector, 2D, no gradient mesh, no 3D, no bevel, no glow, no drop shadow,
no glass, no texture. Crisp even stroke weight throughout, generous negative space.
The look of a technical mark stamped on equipment, not a startup app icon.

Color: a single warm gold (#F0B90B) for all strokes and the center dot, on transparent
background. Exactly one color. No secondary colors.

Composition: the mark occupies about 70% of the canvas, centered, with even margins on
all four sides so it survives a circular crop.

Constraints: no text, no letters, no numbers, no wordmark. Must stay legible when scaled
down to 32x32 pixels. Do not resemble the Binance or BNB Chain logo in any way — no
diamond shapes, no four-square arrangement, no tilted squares.

Output: 512x512 PNG with alpha.
```

### 如果要更有"agent"感的变体，把 subject 段换成：

```
Subject: a hexagon outline containing a simplified robot head reduced to pure geometry —
a rounded square face with two small square eyes and a single short antenna with a dot on
top. No mouth, no features beyond those. The hexagon frames the head with even spacing.
```

---

## X 横幅提示词（1500×500）

```
A wide minimal banner for a blockchain project's social profile, 1500x500.

Background: a deep near-black neutral (#0B0E11) with a very subtle darker hexagonal grid
pattern, barely visible, occupying the full width.

Foreground: the same gold (#F0B90B) hexagon-with-center-node mark, placed on the left
third, at a modest size. To its right, a horizontal row of small gold dots connected by
thin lines, thinning out and fading toward the right edge — suggesting a network being
built outward from nothing.

Style: flat vector, very restrained, mostly empty space. No text, no 3D, no glow,
no photographic elements. The right half should be mostly empty dark space.
```

---

## 挑完之后

把 PNG 放到项目里这两个位置，告诉我文件名，我接进网站和发射表单：

- `web/assets/logo-512.png`
- `web/assets/banner-1500x500.png`

我会另外从 512 的那张生成 `favicon.ico`（16/32/48 三档）并替换现在的占位六边形 SVG。
