---
name: QueueBit
description: A quantum-safe account for the wallet you already have, set as a short technical paper whose figures run.
colors:
  paper: "oklch(0.984 0.004 255)"
  paper-2: "oklch(0.962 0.007 258)"
  paper-3: "oklch(0.935 0.01 260)"
  rule: "oklch(0.85 0.014 262)"
  rule-soft: "oklch(0.91 0.01 262)"
  ink: "oklch(0.21 0.03 266)"
  ink-2: "oklch(0.43 0.028 266)"
  ink-3: "oklch(0.56 0.022 266)"
  plate-blue: "oklch(0.52 0.2 266)"
  plate-blue-2: "oklch(0.66 0.13 266)"
  blue-wash: "oklch(0.935 0.035 266)"
  on-blue: "oklch(0.985 0.005 266)"
  forgeable-red: "oklch(0.54 0.19 27)"
  red-wash: "oklch(0.945 0.03 27)"
  selection: "oklch(0.9 0.06 266)"
  cyanotype-paper: "oklch(0.385 0.105 256)"
  cyanotype-paper-2: "oklch(0.415 0.105 256)"
  cyanotype-rule: "oklch(0.6 0.08 250)"
  cyanotype-rule-soft: "oklch(0.49 0.095 254)"
  cyanotype-ink: "oklch(0.975 0.01 240)"
  cyanotype-ink-2: "oklch(0.89 0.03 242)"
  cyanotype-ink-3: "oklch(0.8 0.045 245)"
  cyanotype-line: "oklch(0.93 0.055 235)"
  cyanotype-line-2: "oklch(0.8 0.07 240)"
  cyanotype-on-line: "oklch(0.33 0.1 256)"
  cyanotype-red: "oklch(0.85 0.11 40)"
typography:
  display:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "clamp(2.3rem, 4.1vw, 3.6rem)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.022em"
  headline:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "clamp(1.55rem, 2.4vw, 2.15rem)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  title:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "clamp(1.3rem, 1.9vw, 1.6rem)"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "1.04rem"
    fontWeight: 400
    lineHeight: 1.66
    fontFeature: "\"kern\", \"liga\", \"onum\""
  abstract:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "1.02rem"
    fontWeight: 400
    lineHeight: 1.62
  note:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "0.86rem"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "STIX Two Text, Times New Roman, serif"
    fontSize: "0.84rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "9px"
    fontWeight: 400
    letterSpacing: "0.06em"
    fontVariation: "\"wdth\" 87.5"
  folio:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "0.68rem"
    fontWeight: 400
    letterSpacing: "0.06em"
  code:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "0.86rem"
    fontWeight: 400
    lineHeight: 2
  readout:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"tnum\", \"lnum\""
rounded:
  none: "0px"
  focus: "2px"
spacing:
  gutter-phone: "16px"
  gutter: "32px"
  column-gap: "48px"
  plate-inset-phone: "12px"
  plate-inset: "20px"
  wide-lead: "48px"
  section-phone: "56px"
  section: "80px"
  section-end: "96px"
  page-max: "1240px"
components:
  button-begin:
    backgroundColor: "{colors.plate-blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "48px"
  button-begin-sm:
    backgroundColor: "{colors.plate-blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "32px"
  running-head:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    height: "48px"
  margin-note:
    textColor: "{colors.ink-2}"
    typography: "{typography.note}"
  algorithm-band:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
  readout:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.plate-blue}"
    typography: "{typography.readout}"
    rounded: "{rounded.none}"
---

# Design System: QueueBit

## 1. Overview

**Creative North Star: "The Preprint That Runs"**

QueueBit's surfaces are set as a short technical paper: cool white stock, blue-black ink in a journal serif, numbered sections, margin notes, tables, an algorithm box, references and a colophon. The persuading is done by the figures, which are line-art plates drawn in code in the brand blue and which *run*: the attack sweeps, the signature fills, the payment hits its cap. A reader should feel they are holding a well-made report from a lab that shows its working, not a product page. The dark scheme is a cyanotype: the same paper printed as a blueprint, pale lines on deep blue, not a "dark mode" with glowing accents.

The system explicitly refuses the crypto landing: dark hero, glowing gradient, stat strip, feature cards, hype styling. It also refuses to be a clone of makingsoftware.com: it shares the genre (technical manual with animated plates) but owns its materials (STIX on cool paper, Bayer-dithered plates, crop marks, cyanotype, fixed-digit readouts). Density is that of a paper: generous measure, quiet furniture, one action color.

Layout is a 12-column page (max 1240px, 48px column gap; 16px gutters on phones, 32px from 640px). A section is a hairline rule across the page, a numbered headline spanning all twelve columns, body copy in the first seven (66ch measure), a margin note in columns 9 to 12, and a wide plate across all twelve. The hero splits 5/7: title, byline, abstract and the begin control on the left; Figure 1 on the right, spanning both rows. Sections breathe at 56px top and 64px bottom on phones, 80px and 96px from 1024px.

**Key Characteristics:**
- A paper's furniture, used literally: running head with folio, byline, abstract, numbered sections, margin notes, Table 1, Algorithm 1, Limitations, References, colophon.
- Plates are SVG line art with crop marks; every tone is an ordered 4×4 Bayer dither.
- Two inks of meaning in plates: blue for the construction, red for what fails.
- Serif for everything a reader reads; mono only for what an instrument would print.
- Square corners, hairline rules, no shadows; depth comes from rules, dither and the one paper-2 band.
- Motion lives only inside plates, one clock per plate, running only while the plate is on screen.

## 2. Colors: The Paper and Cyanotype Palette

Every neutral is tinted toward the brand hue (255 to 266), so paper reads cool and ink reads blue-black; color is OKLCH throughout and the frontmatter carries it as canonical.

### Primary
- **Plate Blue** (`plate-blue`): the QueueBit brand blue (#2F5BEA family). It draws the plates, fills the begin control, numbers the sections, colors citations and readout digits, and rings focus. In cyanotype it becomes the pale blueprint line (`cyanotype-line`) and the begin control turns pale with deep-blue text (`cyanotype-on-line`).
- **Plate Blue Light** (`plate-blue-2`): secondary plate strokes (untouched branches, faint construction lines) and the unlit leading zeros of a readout.
- **Blue Wash** (`blue-wash`): a pale field behind highlighted plate regions; never a page background.

### Secondary
- **Forgeable Red** (`forgeable-red`): the failure ink. In Figure 1 the elliptic-curve key turns red when the sweep recovers it; in Figure 5 the fourth payment is stopped red at the daily-cap gate. In cyanotype it warms to a pale coral (`cyanotype-red`) so it stays legible on blueprint. `red-wash` is its pale field.

### Neutral
- **Paper** (`paper`): the page. Also the knockout patch behind plate labels and the face of readouts.
- **Paper 2** (`paper-2`): the one tonal band on the landing, the Procedure section (Algorithm 1 and the closing begin control).
- **Paper 3** (`paper-3`): reserved third paper step; harness surfaces only.
- **Rule** (`rule`) and **Rule Soft** (`rule-soft`): section rules, the running head's bottom border, the abstract's top rule (rule); table row dividers, margin-note top rules, readout cell dividers (rule-soft).
- **Ink** (`ink`): headlines, body, table head and foot rules, the colophon rule, the Algorithm box rules.
- **Ink 2** (`ink-2`): notes, captions, byline, nav, table body copy, references.
- **Ink 3** (`ink-3`): crop marks, the folio, algorithm line numbers and comments, the ink arrowhead and ink dither in plates.
- **Selection** (`selection`): text selection only.

### Named Rules
**The Red Means Failure Rule.** Red appears only where the story fails for someone: the forgeable key, the refused payment. It is never brand, never emphasis, never a CTA, and a plate carries at most one red event. If red is decorating, delete it.

**The Cyanotype Rule.** The dark scheme is a blueprint print of the same paper: deep blue stock, pale lines, coral for red. Never black, never neon, never a glowing accent.

**The One Action Rule.** The filled blue block is the begin control and nothing else. Every other link is underlined text or plain ink.

## 3. Typography

**Body Font:** STIX Two Text (with Times New Roman, serif), regular, semibold and italic; old-style figures by default.
**Label/Mono Font:** Martian Mono (with ui-monospace, SF Mono, Menlo), set at 87.5% width in plate labels.

**Character:** A journal face carries everything a reader reads, headline to reference; a narrow measuring mono speaks only for the instruments: plate annotations, readouts, the folio, pseudocode, short codes. The pairing reads as a paper with its figures, never as an app.

### Hierarchy
- **Display** (600, clamp(2.3rem, 4.1vw, 3.6rem), 1.04, -0.022em, balanced): the paper title, once, in the hero.
- **Headline** (600, clamp(1.55rem, 2.4vw, 2.15rem), 1.15, -0.015em, balanced): numbered section heads. The number is set in regular weight Plate Blue with tabular figures, 12px before the title.
- **Title** (600, clamp(1.3rem, 1.9vw, 1.6rem)): unnumbered back matter heads (Limitations); References drops to 1.15rem.
- **Body** (400, 1.04rem, 1.66, max 66ch): section prose; root is 17px at 1.6 with kern, liga and onum. Variables (*k*, *P*, *G*) are serif italic.
- **Abstract** (400, 1.02rem, 1.62, max 60ch): opens with a semibold run-in "Abstract."
- **Note and Caption** (400, 0.86rem/1.55 and 0.84rem/1.5): margin notes, references, captions. Captions run in "**Figure n.** Title. Sentence." form, max 68ch.
- **Label** (Martian Mono 400, 8 to 11px in plate units, 9 and 10 the norm, 0.06em, uppercase; lowercase only when case carries meaning, such as formulas and hex): plate annotations.
- **Folio and code** (Martian Mono, 0.68rem 0.06em uppercase for the folio; 0.86rem at line-height 2 for Algorithm 1, 0.8rem on phones; 0.72 to 0.78rem uppercase for table codes and legend numerals).
- **Readout** (Martian Mono, 1.05rem, tabular lining figures): fixed-digit counters.

### Named Rules
**The Instrument Voice Rule.** Mono is for what a machine would print: plate labels, readouts, the folio, pseudocode, codes in a table cell. Mono is prohibited for headlines, body, buttons, nav, and any label above a heading.

**The Run-In Rule.** Paper furniture labels itself in-line, in semibold serif, the way journals do: "Abstract.", "Figure 3.", "Table 1.", "Algorithm 1.", "Fees." Never a separate small-caps line above the content.

## 4. Elevation

The system is flat. There are no shadows anywhere in the product; the only box-shadow in the stylesheet is the focus ring (2px paper, then 2px Plate Blue). Depth is printed, not lit: hairline rules separate sections, a heavier ink rule closes tables, the Algorithm box and the colophon; the Procedure band steps to `paper-2`; inside plates, volume (the exploded account in Figure 2, the slabs, the sweep) is built from isometric projection and dither density.

### Named Rules
**The Printed Depth Rule.** If something needs to stand forward, draw it: a rule, a denser dither, an isometric face. Never a drop shadow, a blur, or a translucent layer.

**The Dither-Only Tone Rule.** Inside a plate every fill tone is an ordered 4×4 Bayer dither from the shared set (blue at 2, 4, 8 and 12 of 16; red at 4 and 8; ink-3 at 3), 1.6-unit cells. Gradients, alpha fills and soft glows are forbidden as tone. Opacity is allowed only as time, to fade an element in or out of a sequence.

## 5. Components

### Begin control (Buttons)
Character: a solid blue block, square and plain, the only filled thing on the page.
- **Shape:** square corners (0px).
- **Large:** Plate Blue fill, on-blue semibold serif at 1rem, 48px tall, 20px sides, label "Start with a passkey", followed by a 14×10 drawn arrow (1.4 stroke). Used in the hero and in Procedure.
- **Small:** 32px tall, 12px sides, 0.86rem, label "Start"; in the running head.
- **Hover / Focus:** fill deepens to 86% blue mixed with ink over 200ms; the arrow slides 2px right over 300ms on the ease-out curve. Focus is the shared paper-then-blue ring, 2px radius.
- **Secondary:** a plain ink-2 serif text link beside it ("or use the browser extension"). Links carry a 1px underline at 45% current color, offset 0.18em, full color on hover.

### Running head (Navigation)
- Sticky, 48px tall, paper ground, rule bottom border. The mark (20px drop with keyhole) and "QueueBit" in semibold serif; section links in 0.86rem ink-2 serif, ink on hover, shown from 768px; the folio "Report QB-1 · Nov 2026" in the mono folio style from 1024px; the small begin control at the right edge.

### Section, Body, Note, Wide
- **Section:** a rule across the page, then the numbered headline across twelve columns.
- **Body:** columns 1 to 7, 66ch, 16px between paragraphs.
- **Note:** columns 9 to 12, max 48ch, rule-soft top rule with 12px above the text, ink-2. On phones it falls under the body with 24px above. A note states a caveat or a fact, never a pull quote.
- **Wide:** 48px below the prose, all twelve columns; holds a plate and its legend or table.

### Plate (Figures)
Character: a print sheet with its registration marks.
- Four 12px crop marks in ink-3 hairline at the corners; 12px inset on phones, 20px from 640px. No frame, no fill, no card.
- The drawing is SVG built from geometry; strokes are hairlines (0.7 to 0.9 is the norm, 1 to 1.4 for the active path). Arrowheads are open chevrons in blue or ink-3.
- **Labels** knock out a paper patch behind the text so they stay legible over lines and dither, and leave by a 0.7 leader from the text edge facing their target, ending in the arrowhead.
- Caption below, outside the crop marks: "**Figure n.** Title." in ink, then the sentence in ink-2.
- Every plate carries a full-sentence accessible description of what the animation shows.
- A numbered legend may follow a plate: mono blue numerals, semibold serif term, ink-2 gloss, two columns from 640px.

### Table
- Caption above in the run-in form ("**Table 1.** ..."). Ink rules at head and foot, rule-soft between rows, semibold column heads, row heads in regular serif, codes in uppercase mono.
- **Phone restack:** below 640px the table becomes a definition list in the same rules: the row head and its code on one line, the explanation under it. Never a horizontally scrolled table.

### Algorithm box
- Set on the `paper-2` band, between ink rules, headed "**Algorithm 1.** Start". Mono pseudocode at line-height 2 with ink-3 line numbers in a 2ch column; comments are ink-3 after a ▷ mark, inline from 640px and on their own line on phones. The closing begin control sits in the margin columns beside it.

### Readout
Character: a nixie-style counter, not a number in a sentence.
- Every digit owns a fixed cell (1.15em × 1.9em) inside a rule-bordered paper strip, cells divided by rule-soft hairlines; digits in Plate Blue; leading zeros dimmed in Plate Blue Light. Unit in uppercase mono ink-2 beside it.
- A changed digit settles into its cell (420ms, drops 35% with a 1.5px blur clearing, ease-out). The whole readout is announced as one labelled value.

### Back matter
- **Limitations:** a two-column definition list with semibold run-in terms and ink-2 text; stated plainly, never hidden.
- **References:** numbered [n] list, max 90ch, cited in text as blue [n] links.
- **Colophon:** ink top rule, ink-2 0.8rem, naming the faces and "Figures drawn in code."

### Motion grammar
- **One clock per plate.** A plate's time starts when it is 15% visible, freezes when it leaves the screen, and resumes where it stopped (frame steps capped at 50ms). Plates loop on their own cycles (roughly 5 to 9 seconds).
- **Curves.** Arrivals use exponential ease-out (1 - 2^(-10x)); travel along a path uses cubic ease-in-out; CSS state changes use cubic-bezier(0.22, 1, 0.36, 1). No bounce, no elastic.
- **Reduced motion** shows each plate's explanatory still: the frame where the whole story is on the page at once (both outcomes in Figure 1, all four steps done in Figure 6), not frame zero.
- Page chrome does not animate beyond hover states.

### Responsive
- Below 640px wide plates are recomposed vertically for the phone (their own tall layouts), never shrunk. The hero stacks title, Figure 1, abstract, begin control; notes fall under body; tables restack.

## 6. Do's and Don'ts

### Do:
- **Do** set every new surface as part of the paper: numbered sections, run-in labels, captions in "Figure n." form, a Limitations section where limits exist.
- **Do** draw explanation as a plate: SVG from geometry, crop marks, Bayer dither tones from the shared set, knocked-out mono labels with leaders.
- **Do** keep red for the single failure event in a plate (the forgeable key, the refused payment).
- **Do** give every plate one on-screen-only clock and an explanatory reduced-motion still.
- **Do** recompose wide drawings vertically below 640px.
- **Do** show quantities as fixed-digit readouts when they change, with real figures from the repo (4,276 bytes, 120,000 signatures).
- **Do** keep corners square (0px) and separate with hairline rules.

### Don't:
- **Don't** build the crypto landing: no dark hero, no glowing gradient, no stat strip, no feature cards, no crypto/hype styling.
- **Don't** use a gradient anywhere, in a plate or on the page; tone is dither.
- **Don't** put an eyebrow or kicker above a heading; the section number and run-in labels are the only labels.
- **Don't** use cards: no bordered, rounded or shadowed boxes holding content. Plates have crop marks, not frames.
- **Don't** use glass: no translucent panels, no backdrop blur, no frosted chrome.
- **Don't** use em dashes in copy; use a colon, a comma or a full stop.
- **Don't** use mono for prose, headings, buttons or navigation.
- **Don't** use red as brand, emphasis or a second accent.
- **Don't** shrink a desktop drawing onto a phone or hide a figure behind sideways scroll.
- **Don't** animate a plate off screen or start it from a blank frame for reduced-motion users.
- **Don't** read as a clone of makingsoftware.com: keep QueueBit's own paper, inks, dither, crop marks and cyanotype rather than borrowing that site's layout, palette or illustration style.
