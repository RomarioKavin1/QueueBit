---
name: QueueBit
description: A quantum-safe account for the wallet you already have, set as a technical manual whose figures run.
colors:
  paper: "#fbfbfb"
  ink: "#171717"
  ink-2: "oklch(0 0 0 / 0.62)"
  ink-3: "oklch(0 0 0 / 0.5)"
  rule: "oklch(0.86 0.005 265)"
  rule-soft: "oklch(0.92 0.004 265)"
  grid-dot: "oklch(0 0 0 / 0.1)"
  manual-blue: "oklch(0.5058 0.2886 264.84)"
  blue-2: "oklch(0.66 0.18 266)"
  blue-t1: "oklch(0.965 0.022 266)"
  blue-t2: "oklch(0.925 0.05 266)"
  blue-t3: "oklch(0.8 0.11 266)"
  blue-t4: "oklch(0.68 0.17 266)"
  on-blue: "#fbfbfb"
  forgeable-red: "oklch(0.55 0.21 27)"
  red-wash: "oklch(0.93 0.04 27)"
  red-t: "oklch(0.86 0.08 27)"
  selection: "oklch(0.88 0.08 266)"
typography:
  wordmark:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "clamp(3.4rem, 9vw, 8.4rem)"
    fontWeight: 400
    lineHeight: 0.86
    letterSpacing: "0.01em"
  headline:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "1.12rem"
    fontWeight: 500
    lineHeight: 1.4
  lede:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "clamp(0.94rem, 0.86rem + 0.18vw, 1.03rem)"
    fontWeight: 400
    lineHeight: 1.85
    fontFeature: "\"kern\", \"liga\", \"calt\""
  note:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.02em"
  section-number:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
  fig-tag:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.04em"
  plate-label:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "9px"
    fontWeight: 400
    letterSpacing: "0.04em"
  code:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 2.1
  readout:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"tnum\", \"lnum\""
rounded:
  none: "0px"
spacing:
  gutter-phone: "20px"
  gutter: "40px"
  column-gap: "64px"
  stack-gap: "40px"
  section-phone: "64px"
  section: "96px"
  plate-inset-phone: "24px 28px"
  plate-inset: "32px 40px"
  page-max: "1600px"
components:
  button-start:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "36px"
  button-start-hover:
    backgroundColor: "{colors.manual-blue}"
    textColor: "{colors.on-blue}"
  button-start-sm:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "28px"
  top-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    height: "48px"
  nav-link:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
  nav-link-hover:
    textColor: "{colors.manual-blue}"
  plate:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.manual-blue}"
    rounded: "{rounded.none}"
    padding: "{spacing.plate-inset}"
  algorithm-box:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "{spacing.plate-inset}"
  readout:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.manual-blue}"
    typography: "{typography.readout}"
    rounded: "{rounded.none}"
---

# Design System: QueueBit

## 1. Overview

**Creative North Star: "The Manual That Runs"**

QueueBit's surfaces are set as one continuous sheet of a technical manual: a near-white page, near-black ink in a book serif set justified, and a single electric blue that draws every figure. Text and animated figure plates share a three-column flow, the text in one column and the plate across the other two, the plate changing sides from row to row. Nothing divides the sections but space. The persuading is done by the figures, which are drawn in code and *run*: the attack sweeps, the signature fills, the fourth payment is refused. The page reads as a manual that shows its working, never as a product page.

**Lineage, stated honestly.** On 2026-11-07 the user replaced the previous world (STIX Two and Martian Mono on cool paper, Bayer-dithered plates, crop marks, visible captions, a cyanotype dark scheme) and asked for the colour scheme and text layout to match makingsoftware.com exactly, with continuous flow and a top bar and logo in that aesthetic. The palette (paper, ink, the blue and its tints, half-ink labels), the justified serif text layout, the dot-grid plate panels with vertical tags, and the dither-band dividers are therefore deliberately matched to that site. The figures, the pixel wordmark, the pixel keyhole mark and every word of copy are QueueBit's own, and the product truth they carry comes from PRODUCT.md (measured figures only; no users, audits or mainnet claims).

The system refuses the crypto landing: dark hero, glowing gradient, stat strip, feature cards, crypto/hype styling. It is light only; the manual is a printed object.

**Scope.** This world is built in `apps/web` (the landing, and the PWA start URL). The browser extension (`apps/extension`) has not adopted it yet and still carries its own earlier styling; new extension surfaces should move toward this system, not extend the old one.

**Key Characteristics:**
- One sheet, light only: #fbfbfb paper, #171717 ink, one electric blue, red only for what can be forged.
- Two voices: EB Garamond for everything read, Departure Mono for the wordmark, labels, numbers, controls and navigation.
- Three-column flow: text column beside a two-column plate, alternating sides; gap-only separation between sections.
- Plates on a faint dot grid, tagged vertically with FIG_00n on the left and [ TITLE ] on the right; no visible caption.
- ░ dither bands, set in Departure Mono, are the only dividers: under the hero, in the top bar, in the footer.
- Square corners everywhere; no shadows, no cards, no glass.

## 2. Colors: The Manual Palette

A near-white sheet, near-black ink, one electric blue for every line, and flat light tints of that blue for every fill.

### Primary
- **Manual Blue** (manual-blue): every line in every plate, the pixel wordmark, the pixel mark, section numbers, citation links, plate labels, readout digits, and the hover fill of the Start control. Its chroma sits beyond sRGB; on sRGB screens and in the rasterised app icons it lands near #1f3bff.
- **Blue Light** (blue-2): secondary lines in a plate (the branches not taken, construction lines, dashed guides) and dimmed leading zeros in readouts.
- **Blue Tints t1 to t4** (blue-t1, blue-t2, blue-t3, blue-t4): the only fills inside a plate, flat, from faintest (t1) to strongest (t4). Slabs, boxes, bars and highlighted nodes take a tint; nothing takes a gradient.

### Tertiary
- **Forgeable Red** (forgeable-red): the single failure event in a plate and nothing else: the elliptic-curve key that a quantum computer recovers, the payment the chain refuses. Its flat tints (red-wash, red-t) fill the refused block and the recovered key's halo.

### Neutral
- **Paper** (paper): the page, the top bar, every plate panel, and the knockout patch behind plate labels.
- **Ink** (ink): body text, headings, the Start control's border and text, the head rule of a table.
- **Ink 2** (ink-2): half-strength reading text: table explanations, references, the note under the procedure, ink-toned plate labels.
- **Ink 3** (ink-3): the quietest voice: navigation at rest, vertical figure tags, algorithm line numbers and comments, the dither band, footer furniture, ink arrowheads.
- **Rule** and **Rule Soft** (rule, rule-soft): row rules in the stacked table, readout borders and digit dividers, scrollbars.
- **Grid Dot** (grid-dot): the dots of the plate grid, every 4px.
- **Selection** (selection): text selection, with ink text.

### Named Rules
**The One Blue Rule.** Every drawn line on the page is the manual blue or its light variant; fills are its flat tints. A second accent colour is prohibited.

**The Forgeable Rule.** Red appears only where something can be forged or is refused, at most one event per plate. Red as brand, emphasis or decoration is prohibited. If a reader can't say what failed when they see red, the red is wrong.

**The Light-Only Rule.** There is no dark scheme. Do not add one, and do not add `prefers-color-scheme: dark` styling to any surface in this world.

## 3. Typography

**Body Font:** EB Garamond (with Georgia, serif), regular and italic, weights 400 to 600.
**Label/Mono Font:** Departure Mono (with ui-monospace, SF Mono, Menlo), self-hosted from `apps/web/app/fonts` with its OFL licence beside it.

**Character:** An old-style book serif set justified at airy leading, interrupted only by a pixel mono that measures, labels and operates. The serif is read; the mono is consulted.

### Hierarchy
- **Wordmark** (Departure Mono 400, clamp(3.4rem, 9vw, 8.4rem), line-height 0.86, uppercase, manual blue): the QUEUEBIT title across two columns of the hero. Used once per surface.
- **Headline** (EB Garamond 500, 1.12rem, 1.4, left-aligned): section headings, preceded by a two-digit mono section number (01 to 06) in blue. Headings are deliberately small; the plates carry the scale.
- **Lede** (EB Garamond 400, 1.05rem, 1.6): the hero promise and the report line (the latter at 500), right-aligned in the hero's third column on desktop.
- **Body** (EB Garamond 400, fluid 0.94 to 1.03rem, line-height 1.85, justified with hyphenation and pretty wrapping, 1.4em between paragraphs): all running text. Measure is set by the column, roughly 55 to 70 characters.
- **Drop cap** (EB Garamond 500, 3.55em, floated two lines deep): the first letter of the abstract only.
- **Note** (EB Garamond 400, 0.88 to 0.95rem, 1.6, ink-2): table explanations, references, the extension note, the legend glosses.
- **Label** (Departure Mono 400, 12px, 0.02em, uppercase): controls, navigation, the wordmark beside the mark (13px), table and algorithm headers (11 to 12px), footer furniture.
- **Section number** (Departure Mono 13px, blue, zero-padded).
- **Figure tag** (Departure Mono 10px, 0.04em, uppercase, ink-3, set vertically top to bottom).
- **Plate label** (Departure Mono 9px default, 8 to 10px in practice, 0.04em, uppercase unless case carries meaning, as in formulas and hex).
- **Code** (Departure Mono 13px on phones, 14px from 640px, line-height 2.1): the algorithm box.
- **Readout** (Departure Mono 1.05rem, tabular lining digits): fixed-digit counters inside plates.
- **Citation** (Departure Mono 11px, blue): bracketed [n] links in running text.

### Named Rules
**The Two Voices Rule.** Prose, headings and the drop cap are always EB Garamond. The wordmark, labels, numbers, navigation, controls, code and readouts are always Departure Mono. Mono for a paragraph, or serif for a control, is prohibited.

**The Justified Column Rule.** Running text is justified and hyphenated in its column; headings, tables, lists and the hero lede are left- or right-aligned, never justified.

## 4. Elevation

The system is flat. There are no shadows anywhere: no card shadow, no hover lift, no glow. Depth inside a figure comes from drawing (isometric slabs, exploded layers, flat tint fills), and structure on the page comes from the dot-grid panel and space. The only box-shadow in the build is the focus ring: a 2px paper gap and a 1.5px manual-blue ring outside it.

### Named Rules
**The Flat Sheet Rule.** If anything on the page looks lifted off the paper, it is wrong. Panels sit in the sheet; they are not stacked on it.

## 5. Components

### Top Bar
Character: a manual's running head, in the mono.
- Sticky, opaque paper, 48px tall, page width (max 1600px, 20px gutters on phones, 40px from 640px). No bottom rule.
- Left: the pixel keyhole mark (17px) and QUEUEBIT in the 13px label in ink. Middle: a ░ dither band filling the free width. Right: five mono nav links in ink-3 (shown from 1024px), then the small Start control.
- Nav links turn manual blue on hover; no underline.

### Buttons (Start)
Character: a typed command in a ruled box.
- **Shape:** square corners (0px), 1px ink border, paper fill.
- **Primary:** "Start with a passkey" in the label face with a pixel right-arrow drawn as a crisp-edged SVG; 36px tall, 14px inline padding, 13px label.
- **Small:** "Start", 28px tall, 10px padding; used in the top bar.
- **Hover:** border and fill turn manual blue, text turns paper (200ms colour transition); the arrow nudges 2px right (300ms, ease-out).
- **Focus:** the shared focus ring.
- There is one action on the landing. Never add a second filled or bordered button beside it.

### Links
- Body links underline in a 1px dotted line offset 0.2em, turning solid on hover. Citations are mono [n] in blue with no underline until hover.

### Rows (the page structure)
- Each section is a three-column grid from 1024px (64px column gap): the text column, and the plate spanning two columns, alternating right, left, right. On phones everything stacks, text first, 40px between text and plate.
- Sections are separated by space only: 64px on phones, 96px from 1024px. No rules, no bands, no background changes between sections.

### Hero
- Wordmark across two columns; the lede, report line and Start control in the third column, bottom-aligned and right-aligned on desktop. A full-width ░ dither band closes the hero.

### Dither Band
Character: the manual's only divider.
- A run of ░ in Departure Mono at 12px, ink-3 at 60% opacity, clipped to its width; optionally a centred uppercase mono label between two runs (the footer's QUEUEBIT). Decorative and hidden from assistive technology.
- Used in exactly three places: the top bar, under the hero, the footer.

### Plate (signature component)
Character: a drawing pinned to graph paper.
- A paper panel with a 4px dot grid (grid-dot) and a faint dashed edge at 6% black, inset 24px by 28px on phones and 32px by 40px from 640px. Square corners, no fill colour, no shadow.
- Vertical tags in the figure-tag face: FIG_00n at the top left, [ TITLE ] at the top right.
- The drawing is SVG built from geometry. Strokes are hairlines (0.7 to 0.9 is the norm; 1 to 1.4 for the active path). Arrowheads are filled triangles in manual blue or ink-3. Fills are the flat blue tints, or the red tints for the failure event.
- **Labels** sit in the plate-label face with a paper knockout patch behind them, and leave by a 0.7 leader from the text edge facing their target, ending in an arrowhead.
- The caption is not shown. Every plate carries a full-sentence accessible description of the animation and a screen-reader caption ("Figure n. Title. Sentence.").
- A numbered legend may follow in the text column: blue mono numerals, a medium-weight serif term, an ink-2 gloss.

### Algorithm Box
- The same dot-grid panel as a plate, two columns wide, tagged ALG_001 vertically. Headed "Algorithm 1 · Start" in the blue label. Mono pseudocode with ink-3 line numbers in a 2.2ch column; comments are ink-3 after a ▷ mark, inline from 640px and on their own line on phones. The closing text and Start control sit in the third column, bottom-aligned.

### Table (stacked)
- Rendered as a definition list at every width: a mono ink-3 header ("Table 1 · ..."), an ink rule above the first row, a rule between rows. Each row: the medium-weight serif term with its code (blue mono label) on the right, the ink-2 explanation beneath. Never a horizontally scrolled table.

### Readout
Character: a nixie-style counter, not a number in a sentence.
- Every digit owns a fixed cell (1.15em by 1.9em) in a rule-bordered paper strip, cells divided by rule-soft hairlines; digits in manual blue, leading zeros dimmed in blue-2 at 45%. Unit in uppercase mono ink-2 beside it.
- A changed digit drops into its cell (360ms, from 35% above, ease-out). The readout is announced as one labelled value.

### Back Matter and Footer
- **Limitations:** two columns of justified run-in definitions (semibold term, regular text), stated plainly.
- **References:** a numbered list in the note style with blue mono [n] markers, in the third column.
- **Footer:** a dither band with QUEUEBIT centred, then a mono ink-3 line: the licence on the left, "Set in EB Garamond and Departure Mono. Figures drawn in code." on the right.

### Mark
- The QueueBit drop with a keyhole, redrawn as a 13 by 15 bitmap and rendered pixel by pixel in manual blue with crisp edges. The same bitmap, on paper, is the app icon (`apps/web/public/icons/icon.svg` and the PNG icons rendered from it).

### Motion grammar
- **One clock per plate.** A plate's time starts when it is 15% visible, freezes when it leaves the screen, and resumes where it stopped (frame steps capped at 50ms). Plates loop on their own cycles (roughly 5 to 11 seconds).
- **Curves.** Arrivals use exponential ease-out (1 - 2^(-10x)); travel along a path uses cubic ease-in-out; CSS state changes use cubic-bezier(0.22, 1, 0.36, 1). No bounce, no elastic.
- **Reduced motion** shows each plate's explanatory still, the frame where the whole story is on the page at once, never frame zero. CSS animation and transition durations collapse to near zero.
- Page chrome does not animate beyond hover states.

### Responsive
- Below 640px wide plates are recomposed vertically for the phone (their own tall layouts), never shrunk and never scrolled sideways. Below 1024px the three-column flow stacks and the nav links hide, leaving the mark, the band and Start.

## 6. Do's and Don'ts

### Do:
- **Do** keep every surface on the one light sheet: #fbfbfb paper, #171717 ink, the manual blue for every line, flat blue tints for every fill.
- **Do** lay out sections as the three-column flow, text beside a two-column plate, alternating sides, separated by space alone (64px phone, 96px desktop).
- **Do** set running text in EB Garamond, justified and hyphenated at line-height 1.85, and every label, number, control and nav item in uppercase Departure Mono.
- **Do** draw explanation as a plate: SVG from geometry on the dot grid, vertical FIG_00n and [ TITLE ] tags, knocked-out mono labels with leaders and filled arrowheads.
- **Do** keep red for the single failure event in a plate (the forgeable key, the refused payment).
- **Do** give every plate one on-screen-only clock, a full-sentence accessible description, and an explanatory reduced-motion still.
- **Do** recompose wide drawings vertically below 640px.
- **Do** show changing quantities as fixed-digit readouts with real figures from the repo (4,276 bytes, 120,000 signatures).
- **Do** keep corners square (0px) and the page flat.

### Don't:
- **Don't** build the crypto landing: no dark hero, no glowing gradient, no stat strip, no feature cards, no crypto/hype styling.
- **Don't** add a dark scheme or a cyanotype variant; this world is light only.
- **Don't** put a rule, band or background change between sections; the ░ dither band appears only in the top bar, under the hero and in the footer.
- **Don't** show a visible caption under a plate or crop marks around it; the vertical tags and the accessible caption carry the figure's identity.
- **Don't** use a gradient or dither as a tone inside a plate; fills are the flat tints.
- **Don't** put an eyebrow or kicker above a heading; the mono section number is the only label a heading takes.
- **Don't** use cards: no rounded, shadowed or filled boxes holding content. The dot-grid panel is the only container.
- **Don't** use glass: no translucent panels, no backdrop blur, no frosted chrome.
- **Don't** use em dashes in copy; use a colon, a comma or a full stop.
- **Don't** set a paragraph or heading in Departure Mono, or a control or nav item in the serif.
- **Don't** use red as brand, emphasis or a second accent.
- **Don't** shrink a desktop drawing onto a phone or hide a figure behind sideways scroll.
- **Don't** animate a plate off screen or start it from a blank frame for reduced-motion users.
- **Don't** claim audits, mainnet availability or protected mainnet funds, and never invent users, testimonials, partners or TVL (PRODUCT.md).
