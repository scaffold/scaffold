# Scaffold — Pitch Deck

A Slidev deck for Scaffold. Investor-focused core (~15 slides) plus a technical
appendix that you can skip or deep-dive on demand.

## Install

```sh
cd pitch
npm install
```

## Run

```sh
npm run dev          # open localhost:3030
npm run build        # static SPA in dist/
npm run export       # export to PDF (first run: npm i -D playwright-chromium)
```

## Structure

- `slides.md` — deck content, driven by Slidev-flavored markdown
- `layouts/` — custom layouts matching the Scaffold design system
- `styles/` — design tokens + global overrides
- `public/` — logos (copied from the design-system bundle)

## Presenter notes

- The investor-core runs from the title to the closing slide ("Foundation…").
- After the closing there is a divider slide (`Technical appendix`), then the
  deep-dive decks. Stop at the divider for non-technical audiences; continue for
  a protocol crowd, or jump straight to any appendix slide via Slidev's overview
  (`o` key) when a question comes up.

## Theme

Raw, dark mode. Signal orange accent. Space Grotesk display, Inter body,
JetBrains Mono kickers and code. To try other palettes, swap `data-theme` on
`html` in `styles/index.css` — see the design system's `tokens.css` for the
available themes (raw, bone/moss, lime/glacier, mono/copper, graphite/ink,
blueprint/coal).
