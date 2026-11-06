---
name: QueueBit
description: A quantum-safe account for the wallet you already have, set as a technical manual whose figures run.
colors:
  paper: "#fbfbfb"
  paper-2: "oklch(0.97 0.006 265)"
  paper-3: "oklch(0.945 0.012 265)"
  ink: "#171717"
  ink-2: "oklch(0 0 0 / 0.62)"
  ink-3: "oklch(0 0 0 / 0.5)"
  rule: "oklch(0.86 0.005 265)"
  rule-soft: "oklch(0.92 0.004 265)"
  grid-dot: "oklch(0 0 0 / 0.1)"
  manual-blue: "oklch(0.5058 0.2886 264.84)"
  blue-2: "oklch(0.66 0.18 266)"
  blue-wash: "oklch(0.95 0.03 266)"
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
    fontFamily: "Exo 2, system-ui, sans-serif"
    fontSize: "clamp(3.6rem, 9.4vw, 8.6rem)"
    fontWeight: 200
    lineHeight: 0.95
    letterSpacing: "-0.03em"
  wordmark-bar:
    fontFamily: "Exo 2, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 300
    lineHeight: 1
    letterSpacing: "-0.01em"
  screen-title:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "1.65rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
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
  screen-sub:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "1.02rem"
    fontWeight: 400
    lineHeight: 1.7
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
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.06em"
  section-number:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
  fig-tag:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.04em"
  plate-label:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "9px"
    fontWeight: 400
    letterSpacing: "0.04em"
  code:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 2.1
  readout:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"tnum\", \"lnum\""
  field:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
  word:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "15px"
    fontWeight: 400
    letterSpacing: "0.01em"
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
  app-column: "560px"
  touch: "48px"
  vignette: "132px"
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
  button-app-primary:
    backgroundColor: "{colors.manual-blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "{spacing.touch}"
    width: "100%"
  button-app-primary-disabled:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink-3}"
  button-app-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "{spacing.touch}"
    width: "100%"
  button-app-text:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    height: "44px"
  top-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    height: "48px"
  app-top-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    height: "56px"
  progress-segment:
    backgroundColor: "{colors.rule-soft}"
    height: "3px"
  progress-segment-done:
    backgroundColor: "{colors.manual-blue}"
    height: "3px"
  nav-link:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
  nav-link-hover:
    textColor: "{colors.manual-blue}"
  choice-row:
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    padding: "16px 0"
    height: "84px"
  choice-row-pressed:
    backgroundColor: "{colors.blue-wash}"
  field-input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "{spacing.touch}"
  notice:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "12px 14px"
  notice-error:
    backgroundColor: "{colors.red-wash}"
    textColor: "{colors.ink}"
  vignette:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.manual-blue}"
    rounded: "{rounded.none}"
    height: "{spacing.vignette}"
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

## Overview

**Creative North Star: "The Manual That Runs"**

QueueBit's surfaces are set as one continuous sheet of a technical manual: a near-white page, near-black ink in a book serif set justified, and a single electric blue that draws every figure. On the landing, text and animated figure plates share a three-column flow, the text in one column and the plate across the other two, changing sides from row to row, with nothing but space between sections. The persuading is done by the figures, which are drawn in code and *run*: the attack sweeps, the signature fills, the fourth payment is refused. The app screens (onboarding first) are the same manual folded to a phone: one column, one short line of copy per screen, a small looping drawing at the top, and the action pinned to the bottom.

**Lineage, stated honestly.** On 2026-11-07 the user asked for the colour scheme and text layout to match makingsoftware.com, with continuous flow and a top bar in that aesthetic. The palette (paper, ink, the blue and its tints, half-ink labels), the justified serif text layout and the dot-grid plate panels with vertical tags follow that site at the user's request. The type pairing, the mark, the figures, the vignettes and every word of copy are QueueBit's own, and the product truth they carry comes from PRODUCT.md. The same day the user rejected the pixel style for both the font and the logo: Departure Mono and the bitmap keyhole are gone, replaced by Geist Mono and a vector line-art mark, and the ░ dither bands became dotted rules. After trying script faces, the user chose Exo 2 Extra Light for the name, and the mark became the seal with its Q.

The system refuses the crypto landing: dark hero, glowing gradient, stat strip, feature cards, crypto/hype styling. It is light only; the manual is a printed object.

**Scope.** This world is built in `apps/web` (the landing at `/`, the onboarding at `/start`, the PWA). The browser extension (`apps/extension`) has not adopted it yet and still carries its own earlier styling; new extension surfaces should move toward this system, not extend the old one.

**Motion grammar.** Things move only to show what is happening: a plate runs its mechanism, a vignette loops its one gesture, a readout digit drops into its cell, a control changes colour. Arrivals ease out (cubic-bezier(0.22, 1, 0.36, 1) in CSS, exponential ease-out inside plates); travel along a path eases in and out. No bounce, no elastic, no animated page chrome. With reduced motion every drawing rests on its meaningful state, never on a blank frame.

**Key Characteristics:**
- One sheet, light only: paper, ink, one electric blue for every line, flat blue tints for every fill, red only for what can be forged.
- Two voices: EB Garamond for everything read, Geist Mono for labels, numbers, controls and navigation; the name alone is set in Exo 2, thin.
- Landing: three-column flow, text beside a two-column plate, alternating sides; space-only separation between sections.
- App screens: one 560px column, a dot-grid vignette, a serif title and one line, the action pinned above the safe area.
- Drawings sit on a faint 4px dot grid; dotted rules are the only dividers.
- Vector line art throughout: the mark, the plates and the vignettes are strokes and flat fills, never pixels.
- Square corners everywhere; no shadows, no cards, no glass.

## Colors

A near-white sheet, near-black ink, one electric blue for every line, and flat light tints of that blue for every fill.

### Primary
- **Manual Blue** (manual-blue): every line in every plate and vignette, the wordmark, the mark, section and choice numbers, citation links, plate labels, readout digits, completed progress segments, the hover fill of the Start control and the resting fill of the app primary button. Its chroma sits beyond sRGB; on sRGB screens and in the rasterised app icons it lands near #1f3bff.
- **Blue Light** (blue-2): secondary lines in a plate (branches not taken, construction lines, dashed guides) and dimmed leading zeros in readouts.
- **Blue Tints t1 to t4** (blue-t1 to blue-t4): the only fills inside a plate or vignette, flat, from faintest (t1, also the body of the outline mark) to strongest (t4). Nothing takes a gradient.
- **Blue Wash** (blue-wash): the pressed state of a choice row; the only blue that touches a control's background besides the primary fill.

### Tertiary
- **Forgeable Red** (forgeable-red): the single failure event in a plate (the key a quantum computer recovers, the payment the chain refuses) and, on app screens, a field or notice in error. Its flat tints (red-wash, red-t) fill the refused block, the recovered key's halo and the error notice.

### Neutral
- **Paper** (paper): the page, both top bars, the bottom action bar, every plate and vignette panel, inputs, the knockout patch behind plate labels, and the keyhole of the solid mark.
- **Paper 2 and Paper 3** (paper-2, paper-3): the information notice (paper-2); a disabled primary button and the pressed secondary button (paper-3).
- **Ink** (ink): body text, headings, the borders of the Start control, secondary buttons and inputs, the head rule of tables, choice lists and the word grid.
- **Ink 2** (ink-2): half-strength reading text: screen subtitles, table explanations, references, field labels, the back control.
- **Ink 3** (ink-3): the quietest voice: navigation at rest, step counters, figure tags, line and word numbers, hints, footer furniture, the dots of the dotted rule.
- **Rule** and **Rule Soft** (rule, rule-soft): row rules in tables, choice lists and the word grid; readout borders; unfilled progress segments; scrollbars.
- **Grid Dot** (grid-dot): the dots of the plate and vignette grid.
- **Selection** (selection): text selection, with ink text.

### Named Rules
**The One Blue Rule.** Every drawn line on every surface is the manual blue or its light variant; fills are its flat tints. A second accent colour is prohibited.

**The Forgeable Rule.** Red appears only where something can be forged, is refused, or is in error, at most one event per plate. Red as brand, emphasis or decoration is prohibited. If a reader can't say what failed when they see red, the red is wrong.

**The Light-Only Rule.** There is no dark scheme. Do not add one, and do not add `prefers-color-scheme: dark` styling to any surface in this world.

## Typography

**Body Font:** EB Garamond (with Georgia, serif), regular and italic, weights 400 to 600.
**Label/Mono Font:** Geist Mono (with ui-monospace, SF Mono, Menlo), loaded through next/font and self-hosted at build.

**Character:** An old-style book serif set justified at airy leading, interrupted only by a clean, drawn technical mono that measures, labels and operates. The serif is read; the mono is consulted.

### Hierarchy
- **Wordmark** (Exo 2 200 extra light, clamp(3.6rem, 9.4vw, 8.6rem), line-height 0.95, tracking -0.03em, mixed case, manual blue): "QueueBit" across two columns of the landing hero. Used once per surface. Beside the mark in the top bars it is Exo 2 300 at 1.25rem (a hairline does not hold at that size).
- **Screen title** (EB Garamond 500, 1.65rem, 1.2, balanced): the one heading of an app screen. App screens read at arm's length on a phone, so their title carries more than a landing section heading.
- **Screen subtitle** (EB Garamond 400, 1.02rem, 1.7, ink-2): the one line under a screen title. One sentence or two short ones; never a paragraph.
- **Headline** (EB Garamond 500, 1.12rem, 1.4, left-aligned): landing section headings, after a two-digit blue mono section number; also the title of a choice row. Deliberately small; the plates carry the scale.
- **Lede** (EB Garamond 400, 1.05rem, 1.6): the hero promise and report line (the latter at 500).
- **Body** (EB Garamond 400, fluid 0.94 to 1.03rem, line-height 1.85, justified with hyphenation and pretty wrapping, 1.4em between paragraphs): all running text on the landing, roughly 55 to 70 characters per line.
- **Drop cap** (EB Garamond 500, 3.55em, two lines deep): the first letter of the abstract only.
- **Note** (EB Garamond 400, 0.88 to 0.95rem, 1.5 to 1.6, ink-2 or ink-3): table explanations, references, choice glosses, field hints and errors.
- **Label** (Geist Mono 400, 12px, 0.06em, uppercase): controls, navigation, field labels, step counters, table and algorithm headers, footer furniture. Buttons set it at 13px.
- **Section number** (Geist Mono 13px, blue, zero-padded): before landing headings and in choice rows and numbered steps.
- **Figure tag** (Geist Mono 10px, 0.04em, uppercase, ink-3, set vertically).
- **Plate label** (Geist Mono 9px default, 8 to 10px in practice, 0.04em, uppercase unless case carries meaning, as in formulas and hex).
- **Code** (Geist Mono 13px on phones, 14px from 640px, line-height 2.1): the algorithm box.
- **Readout** (Geist Mono 1.05rem, tabular lining digits): fixed-digit counters inside plates.
- **Word and address** (Geist Mono, 15px words, 0.01em): recovery words and addresses, which must be copied exactly.
- **Field input** (16px, never smaller, so iOS does not zoom): text inputs in the serif; secret phrases and keys in the mono.
- **Citation** (Geist Mono 11px, blue): bracketed [n] links in running text.

### Named Rules
**The Two Voices Rule.** Prose, headings and the drop cap are always EB Garamond. Labels, numbers, navigation, controls, code, readouts, words and addresses are always Geist Mono. Mono for a paragraph, or serif for a control, is prohibited. The one exception is the name itself: "QueueBit" as wordmark and the Q of the seal are Exo 2, thin.

**The Drawn Type Rule.** Type is outline type at its designed weights. No pixel, bitmap or dot-matrix face, for the wordmark or anything else.

**The Justified Column Rule.** Running text on the landing is justified and hyphenated in its column; headings, tables, lists, the hero lede and all app-screen text are left- or right-aligned, never justified.

## Layout

**Landing.** Page width up to 1600px with 20px gutters on phones and 40px from 640px. From 1024px each section is a three-column grid (64px column gap): the text column and the plate spanning two columns, alternating right, left, right. On phones everything stacks, text first, 40px between text and plate. Sections are separated by space only: 64px on phones, 96px from 1024px. Below 640px wide plates are recomposed vertically (their own tall layouts), never shrunk and never scrolled sideways. Below 1024px the nav links hide, leaving the mark, the dotted rule and Start.

**App screens.** One column, 560px at most, 20px gutters, mobile first (the PWA runs full screen on phones). A sticky top bar under the safe-area inset; the content column opens with a vignette, then the title and its one line; the action bar is sticky at the bottom, padded by the safe-area inset (at least 16px). Every touch target is at least 44px and controls are 48px.

### Named Rules
**The Space Divides Rule.** Sections are divided by space. A dotted rule appears only in the top bar, under the hero and in the footer; never between sections.

**The One Line Rule.** An app screen says one thing: a title and one line under it. Anything more is a list, a field or a drawing, not a paragraph.

## Elevation & Depth

The system is flat. There are no shadows anywhere: no card shadow, no hover lift, no glow. Depth inside a drawing comes from the drawing (isometric slabs, exploded layers, flat tint fills); structure on the page comes from the dot-grid panel, rules and space. The only box-shadow is the focus ring: a 2px paper gap and a 1.5px manual-blue ring outside it, on every interactive element.

### Named Rules
**The Flat Sheet Rule.** If anything looks lifted off the paper, it is wrong. Panels and bars sit in the sheet; they are not stacked on it, and they are opaque paper, not frosted.

## Shapes

Square corners (0px) on every panel, button, input, notice and segment. Containers are drawn with 1px rules (ink for controls and list heads, rule for rows, a 6% black dashed edge for dot-grid panels), never with fills that make a card. Curves belong to the drawings: the seal's disc, the arcs of a fingerprint, a padlock's shackle, a phone's corners inside a vignette.

**The mark.** A seal: a disc ringed with a line of dots (the plates' dot grid) holding the Q of the wordmark, Exo 2 at weight 500 (heavier than the wordmark so it holds at 16px), embedded as an outline so it renders without the web font. On a 100 by 100 grid. Two variants: the solid (blue disc, paper dot ring and Q), used in both top bars at 24px and in the app icons on paper (#fbfbfb); and the line (blue ring, blue-t1 body, blue dots and Q), used inside drawings. It replaced the drop with a keyhole on 2026-11-07 at the user's request.

## Components

### Top Bar (landing)
Character: a manual's running head, in the mono.
- Sticky, opaque paper, 48px tall, page width. No bottom rule.
- Left: the solid seal (24px) and "QueueBit" in Exo 2 300, 1.25rem, manual blue. Middle: a dotted rule filling the free width. Right: five mono nav links in ink-3 (from 1024px), then the small Start control.
- Nav links turn manual blue on hover; no underline.

### Buttons
Character: a typed command in a ruled box.
- **Shape:** square corners (0px), 1px border.
- **Start (landing):** "Start with a passkey" in the 13px label with a thin right arrow; 36px tall, 14px inline padding, ink border, paper fill. **Small:** "Start", 28px tall, 10px padding, in the top bar.
- **Start hover:** border and fill turn manual blue, text turns paper (200ms colour transition); the arrow nudges 2px right (300ms, ease-out). There is one action on the landing; never add a second bordered or filled button beside it.
- **App primary:** the same command resting in its "on" state, because touch has no hover: manual-blue fill and border, paper label, right arrow, full width, 48px, pinned in the bottom action bar. Pressed: 10% darker. Disabled: paper-3 fill, rule border, ink-3 label. While working, the label is replaced by three small pulsing squares and a short present-tense label ("Moving").
- **App secondary:** paper fill, ink border, ink label, full width, 48px; pressed fills paper-3.
- **Text button:** the label in ink-2 with a dotted underline, 44px tall, centred; for the least likely next step.
- **Focus:** the shared focus ring.

### Links
- Body links underline in a 1px dotted line offset 0.2em, turning solid on hover. Citations are mono [n] in blue with no underline until hover.

### Dotted Rule
Character: the manual's only divider.
- A 7px-tall strip of dots on a 4px pitch, ink-3 at 50% opacity; optionally a centred uppercase mono label between two runs (the footer's QUEUEBIT). Decorative and hidden from assistive technology.
- Used in exactly three places: the landing top bar, under the hero, the footer.

### Plate (signature component)
Character: a drawing pinned to graph paper.
- A paper panel with a 4px dot grid and a faint dashed edge, inset 24 by 28px on phones and 32 by 40px from 640px. No fill colour, no shadow.
- Vertical tags in the figure-tag face: FIG_00n at the top left, [ TITLE ] at the top right.
- The drawing is SVG from geometry. Strokes are hairlines (0.7 to 0.9; 1 to 1.4 for the active path). Arrowheads are filled triangles in manual blue or ink-3. Fills are the flat blue tints, or the red tints for the failure event.
- Labels sit in the plate-label face on a paper knockout and leave by a 0.7 leader ending in an arrowhead.
- No visible caption. Every plate carries a full-sentence accessible description of the animation and a screen-reader caption.
- **Motion:** one clock per plate. It starts when 15% visible, freezes off screen and resumes where it stopped (frame steps capped at 50ms); loops run roughly 5 to 11 seconds. Reduced motion shows the explanatory still, the frame where the whole story is on the page at once.
- A numbered legend may follow in the text column: blue mono numerals, a medium serif term, an ink-2 gloss.

### Algorithm Box
- The same dot-grid panel, two columns wide, tagged ALG_001. Headed in the blue label. Mono pseudocode with ink-3 line numbers; comments in ink-3 after a ▷ mark, inline from 640px and on their own line on phones.

### Table (stacked)
- A definition list at every width: a mono ink-3 header, an ink rule above the first row, a rule between rows. Each row: the medium serif term with its blue mono code on the right, the ink-2 explanation beneath. Never a horizontally scrolled table.

### Readout
Character: a nixie-style counter, not a number in a sentence.
- Each digit owns a fixed cell (1.15em by 1.9em) in a rule-bordered paper strip divided by rule-soft hairlines; digits in manual blue, leading zeros in blue-2 at 45%; unit in uppercase mono ink-2.
- A changed digit drops into its cell (360ms, from 35% above, ease-out). Announced as one labelled value.

### Screen (app frame)
Character: one page of the manual, held in the hand.
- **Top bar:** sticky opaque paper, 56px under the safe area. Left: a Back control (mono label in ink-2 with a left arrow, 44px target), or on the first screen the solid seal and "QueueBit" in Exo 2. Right: the method and step in ink-3 ("PASSKEY · 2 / 4").
- **Progress:** under the bar, one 3px segment per step with 4px gaps; completed steps manual blue, the rest rule-soft. Hidden from assistive technology; the step counter carries it.
- **Action bar:** sticky at the bottom, paper, stacked full-width buttons with 8px between them, padded by the safe area.

### Vignette (signature component, app screens)
Character: a plate's small sibling; one gesture, looping.
- Opens every app screen: a 132px dot-grid panel across the column, the drawing centred at 104px tall. Exposed as one image with a full-sentence label of what it shows.
- Drawn in the plate grammar: manual-blue strokes (1 to 1.8, round caps), flat blue-t1 to t3 fills, the seal drawn in its line variant, check marks as a blue circle on paper with a drawn tick.
- **Motion:** pure CSS loops of a single gesture: a line drawing itself (once, or drawing, holding and clearing), a check or keyhole popping in, a scan line sweeping, slots filling in turn, a padlock shackle closing or opening, a coin travelling on an arc, dots running along paths. Cycles run 2.4 to 3.6 seconds; staggered parts offset by 140 to 800ms. Easing is the shared ease-out, ease-in-out for travel.
- **Reduced motion:** animation is removed and the drawing shows its resting, meaningful state (drawn, filled, closed), never an empty frame.

### Choices
Character: a table of contents you can press.
- A list with an ink rule on top and a rule under each row. Each row is a full-width button at least 84px tall: a blue two-digit mono number, a headline-size serif title with one ink-2 line beneath (and optionally a mono ink-3 note), and an ink-3 arrow on the right that turns blue when pressed. Pressed rows wash in blue-wash; disabled rows sit at 50% opacity.

### Inputs / Fields
- **Style:** a mono ink-2 label above; a 48px input, paper fill, 1px ink border, square, 12px inline padding, 16px text. Phrase and key areas use the mono at 16px, 1.6 leading, no resize, autocorrect and capitalisation off.
- **Focus:** the border turns manual blue (and the shared focus ring).
- **Error:** the border turns red and the hint line is replaced by the error in red; otherwise an ink-3 hint sits beneath.

### Word Grid
- The recovery words, numbered: two columns on a phone, three from 480px, under an ink rule with a rule under each word. Right-aligned ink-3 mono numbers; words in the 15px mono.

### Address
- An address set in groups of four mono characters, the 0x in ink-3 and alternate groups in blue, so it can be read aloud and checked by eye. Lines break only between groups. Announced as the full address.

### Numbered Steps
- What happens next, as a list: blue two-digit mono numbers in a fixed 2.2rem column, serif text at 1rem, 1.6.

### Notice
- An inline message with a 1px border and 12 by 14px padding, square. Information: rule border on paper-2, ink-2 text. Error: red border on red-wash, ink text, led by a red mono ERROR label; it states the problem and what to do, never colour alone.

### Footer
- A dotted rule with QUEUEBIT centred, then a mono ink-3 line: the licence on the left, the typesetting credit on the right.

## Do's and Don'ts

### Do:
- **Do** keep every surface on the one light sheet: paper, ink, the manual blue for every line, flat blue tints for every fill.
- **Do** set running text in EB Garamond and every label, number, control, word, address and nav item in Geist Mono (labels uppercase at 0.06em).
- **Do** draw the mark, figures and vignettes as vector line art: blue strokes, flat tints, round joins.
- **Do** lay out landing sections as the three-column flow, text beside a two-column plate, alternating sides, separated by space alone.
- **Do** open every app screen with a vignette, then a serif title and one line, with the action pinned in the bottom bar.
- **Do** draw explanation as a plate: SVG from geometry on the dot grid, vertical FIG and title tags, knocked-out mono labels with leaders and filled arrowheads.
- **Do** give every plate one on-screen-only clock, and every plate and vignette a full-sentence accessible description and a meaningful reduced-motion state.
- **Do** keep red for the single failure event in a plate, or an error on an app screen.
- **Do** keep inputs at 16px, controls at 48px and touch targets at least 44px.
- **Do** set addresses in groups of four and recovery words in a numbered grid.
- **Do** keep corners square (0px) and the page flat.

### Don't:
- **Don't** use pixel or bitmap type or marks: no pixel fonts, no bitmap logos or icons, no crisp-edged pixel glyphs, no ░ or dither characters as decoration.
- **Don't** build the crypto landing: no dark hero, no glowing gradient, no stat strip, no feature cards, no crypto/hype styling.
- **Don't** add a dark scheme; this world is light only.
- **Don't** put a rule, band or background change between sections; the dotted rule appears only in the top bar, under the hero and in the footer.
- **Don't** show a visible caption under a plate or crop marks around it.
- **Don't** use a gradient or dither as a tone inside a plate or vignette; fills are the flat tints.
- **Don't** put an eyebrow or kicker above a heading; the mono section number is the only label a heading takes.
- **Don't** use cards: no rounded, shadowed or filled boxes holding content. The dot-grid panel, the ruled list and the notice are the containers.
- **Don't** use glass: no translucent panels, no backdrop blur, no frosted bars.
- **Don't** write a paragraph on an app screen; one line under the title.
- **Don't** animate for decoration: a vignette loops one gesture that shows the screen's action; page chrome does not animate beyond state changes.
- **Don't** use em dashes in copy; use a colon, a comma or a full stop.
- **Don't** set a paragraph or heading in Geist Mono, or a control or nav item in the serif.
- **Don't** use red as brand, emphasis or a second accent.
- **Don't** shrink a desktop drawing onto a phone or hide a figure behind sideways scroll.
- **Don't** animate a plate off screen or start any drawing from a blank frame for reduced-motion users.
