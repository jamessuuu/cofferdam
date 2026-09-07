# Font sources and licence verification

All three typefaces are OFL 1.1 (SIL Open Font License). Verified against the
copyright/licence file shipped with the upstream source in every case (copied
alongside this notice as `LICENSE-<Family>.txt`) — not assumed from a name.

| Family | Upstream source | Version fetched | Licence file | Verified |
|---|---|---|---|---|
| Archivo | `github.com/google/fonts` `ofl/archivo/Archivo[wdth,wght].ttf` | Google Fonts main branch, fetched 2026-09-06 | `LICENSE-Archivo.txt` (`OFL.txt` from the same directory) | OFL 1.1, "Copyright 2020 The Archivo Project Authors" |
| Newsreader | `github.com/google/fonts` `ofl/newsreader/Newsreader[opsz,wght].ttf` + `Newsreader-Italic[opsz,wght].ttf` | Google Fonts main branch, fetched 2026-09-06 | `LICENSE-Newsreader.txt` (`OFL.txt` from the same directory) | OFL 1.1, "Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)" |
| Commit Mono | `github.com/eigilnikolajsen/commit-mono` release `v1.143` | `CommitMono-1.143.zip`, fetched 2026-09-06 | `LICENSE-CommitMono.txt` (`license.txt` from the release zip) + `github.com/eigilnikolajsen/commit-mono/blob/main/LICENSE-FONT` (copyright line) | OFL 1.1, "Copyright (c) 2023 Eigil Nikolajsen (eigi0088@gmail.com)" |

Source URLs actually fetched (curl, 2026-09-06):

- `https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth,wght%5D.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/OFL.txt`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/OFL.txt`
- `https://github.com/eigilnikolajsen/commit-mono/releases/download/v1.143/CommitMono-1.143.zip`
- `https://raw.githubusercontent.com/eigilnikolajsen/commit-mono/main/LICENSE-FONT`

No paid assets. No font foundry account used. Zero stock/paid fonts anywhere in this
package.

## Why Instrument Serif was replaced

Instrument Serif was the substrate's original Voice face. It is named explicitly in
the `impeccable` design detector's `overused-font` rule as one of the canonical faces
"each new wave of AI-generated UIs converges on" (alongside Inter, Geist, Space
Grotesk, Fraunces, Plus Jakarta Sans, Recoleta and Instrument Sans). Shipping it
directly contradicted `PORTFOLIO-DESIGN-DNA.md` §2 ("every AI startup dark-gradient
template", "Vercel/shadcn defaults" as anti-references) and §9's named forbidden
list. This is a defect fix, not a re-litigation of taste: same job (DNA §3.1's Voice
role — "exactly one job: the human sentence" — never for UI, never for data, never
below 20px), different face.

## Newsreader: the replacement, and why

**Chosen: Newsreader** (Production Type, commissioned originally for Google News's
reading surfaces), OFL 1.1, Regular + Italic, instanced at **wght=400 opsz=20** from
the official variable release.

Alternatives actually evaluated against the same four requirements (OFL, not on the
overused list, genuine personality at 19-21px, Regular+Italic available):

- **Young Serif** and **Gloock** — both disqualified outright: neither ships an
  Italic anywhere in the Google Fonts source repo (`ofl/youngserif/` and
  `ofl/gloock/` each contain exactly one static Regular file, confirmed by listing
  the actual directory contents, not assumed from the font's marketing page). DNA
  §3.1 requires both styles; this is not negotiable for the Voice role.
- **Spectral** — has Regular+Italic and is OFL, but it was explicitly designed as an
  *unobtrusive* reading face (a "transitional serif" built to disappear into body
  text). That is precisely the "neutral workhorse serif" failure mode the brief
  warns against for a face whose whole job is to sound human. Rejected on the
  personality requirement, not the licence or format requirements.
- **Petrona** — real personality (rounded, warm terminals, distinctly less common
  than any of Newsreader/Literata/Spectral in current AI-generated UIs) and has
  Regular+Italic variable masters. A legitimate alternative; kept in reserve. Its
  character reads slightly more display-leaning at 19-21px than Newsreader's, which
  is more purpose-built for continuous reading at exactly that size band.
- **Literata** — the closest competitor to Newsreader. Also OFL, also
  opsz+wght variable with Regular+Italic, also genuinely well-crafted (built for
  Google Play Books). The two are close enough that either would have satisfied
  every requirement. Newsreader was preferred for three concrete reasons: (1) its
  optical-size axis defaults exactly into the substrate's 19-21px `lead` band — an
  opsz=20 instance sits at the low end of the family's intended "text" range rather
  than requiring a display-range compromise; (2) editorially, Newsreader's brief was
  explicitly to read as considered, human-authored prose (a news byline register),
  which maps directly onto the Voice role's job description ("the human sentence")
  more literally than Literata's book-typography brief; (3) it is measurably less
  present in current AI-generated site templates than Literata, which has started
  appearing in "editorial-styled" AI-generated portfolios over the last year — the
  brief's whole point is to avoid convergence, and picking the option with a
  slightly newer, thinner footprint in that wave is the more defensible bet.

**Genuine personality at 19-21px, not a neutral workhorse:** unlike Georgia,
Spectral or a generic transitional serif, Newsreader carries moderate stroke
contrast, a distinctly warm italic with real cursive letterforms (not a mechanically
slanted roman), and calligraphic details (the ball terminal on the comma/period, the
curved descender on "g" and "y") that stay legible and visibly *considered* at
19-21px rather than reading as a default. The rendered specimen (`specimen-
daylight.png`, `specimen-dusk.png`) was inspected directly, not assumed from a
type-sample page, before this pick was finalised.

### Build: how the shipped files were produced

The official Google Fonts release ships Newsreader as two variable TTFs (`wght
200-800` x `opsz 6-72`, default `wght 400 opsz 18`), ~450-500KB each — far too large
and carrying axis range this package does not use. Build steps, both regular and
italic:

1. **Instance** at `wght=400 opsz=20` (`fonttools varLib.instancer`) — a static,
   single-style TTF. opsz=20 sits just above the family's own default (18),
   matching where the substrate's `lead` token actually renders (19px at 390 ->
   21px at 1440).
2. **Subset** to the same Google Fonts "latin" unicode range every other substrate
   font uses (`fonttools subset --unicodes=...`), with layout features narrowed to
   `kern,liga,mark,mkmk,ccmp` (dropping `case`, `locl`, `ordn`, `pnum`, `sups`,
   `tnum` — numeric/ordinal/superscript/case-sensitive variants that are Commit
   Mono's job, not prose set in the Voice face, per DNA §3.1's own division of
   labour) and hinting stripped (`--no-hinting`; TrueType grid-fitting instructions
   are unnecessary for on-screen webfont rendering at these sizes and cost bytes
   this package's budget cannot spare).
3. **Name table**: family renamed from the variable font's named-instance label
   ("Newsreader 16pt", an artifact of the optical-size axis's own naming) to plain
   "Newsreader"/"Newsreader Italic", nameID 0 (copyright) extended with a one-line
   pointer back to this file, matching the transparency precedent set below for
   Commit Mono's variable build.

This is a **Modified Version** under OFL 1.1 permission 2 (the copyright notice and
this licence travel with it, in `LICENSE-Newsreader.txt` and in the font's own
`name` table ID 0). No Reserved Font Name is declared in the upstream OFL.txt for
"Newsreader", so instancing/subsetting/renaming the family name is permitted.

### One fix made in the same pass: the italic fallback's family name

While rewiring `substrate.css`'s metric-matched fallback `@font-face` blocks (DNA
§3.1's CLS-avoidance mechanism) for the new face, a pre-existing bug in the
Instrument Serif version was found and fixed, not carried forward: the italic
fallback block was declared under a *different* family name
("Instrument Serif Fallback Italic") than the roman fallback
("Instrument Serif Fallback"), while `--font-voice`'s stack only ever named the
roman one. Since a `font-style: italic` request against the `"X Fallback"` family
only matches an italic-flagged `@font-face` sharing *that exact family name*, the
italic-specific size-adjust/ascent-override/descent-override numbers were dead code
— an element rendering italic text before the webfont loaded would fall straight
through to bare system Georgia (correct style, wrong metrics, real if minor CLS).
The Newsreader version fixes this by giving both fallback blocks the *same* family
name (`"Newsreader Fallback"`), differentiated only by `font-style`, exactly
matching the pattern already used for the two real `"Newsreader"` webfont blocks
above them. No other behaviour changed.

## Commit Mono: one honest deviation from the DNA brief, done in the open

The DNA brief calls for "Commit Mono (variable)". **No official variable release of
Commit Mono exists.** The v1.143 release (like every release checked back to 1.132)
ships four static instances only: Regular (400), Italic (400), Bold (700), Bold
Italic (700). This is a fact about the upstream project, not a choice made here —
confirmed by listing every GitHub release asset for the repository, all named
`CommitMono-<version>.zip` containing the same four static files, and by the
project's own `installation.txt`, which describes exactly those four files as "a
Style Group."

Rather than silently ship a static font under a "(variable)" label, or invent a
name, this package **builds a real 2-master variable font** from the official
Regular (400) and Bold (700) statics:

1. Both masters were subset to the Google Fonts "latin" range (see `substrate.css`'s
   `unicode-range`).
2. Glyph-order and contour-count compatibility was checked programmatically after
   subsetting: **0 mismatches across 856 glyphs** (18 glyphs mismatch in the full,
   unsubsetted font — all outside the latin subset: rare accented glyphs and
   stylistic-set alternates not needed here).
3. `fonttools varLib` merged the two compatible masters over a `wght 400-700`
   designspace, producing a genuine `fvar`/`gvar` variable font (verified: `fvar`
   reports axis `wght 400.0 400.0 700.0`; `gvar` present; 856 glyphs).
4. A handful of stylistic-set and contextual-kerning alternate glyphs (`g.leftL`,
   `i.cv04`, etc. — OpenType feature variants, not base letterforms) were skipped by
   varLib as incompatible between masters and are absent from this build. Base
   rendering is unaffected; `calt`/`kern`/`liga`/`tnum` are retained.

This is a **Modified Version** under OFL 1.1 permission 2 (bundling/redistributing
modified copies is explicitly permitted, provided the copyright notice and licence
travel with it — both do, in `LICENSE-CommitMono.txt` and in the font's own `name`
table ID 0). No Reserved Font Name is declared anywhere in the upstream licence
file or the `LICENSE-FONT` copyright header, so the family name "Commit Mono" is not
legally reserved — the `name` table nonetheless carries a version string
(`variable-build:fonttools-varLib`) and an extended copyright notice disclosing the
derivation, so nobody downstream mistakes this for an official release.

**If this deviation is unacceptable, the fallback is trivial**: ship the two
official static weights (400, 700) as two separate `@font-face` blocks with
overlapping `font-weight` ranges (`font-weight: 400 500` / `font-weight: 600 700`)
instead of one variable file. That was the fallback plan; the variable build was
attempted first, verified compatible, and used because it actually delivers weight
500 (used by `--text-micro` and `--text-readout`) rather than rounding it to the
nearest static.
