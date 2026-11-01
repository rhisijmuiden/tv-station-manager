# House styles

Each folder in `branding/` is one complete house style (brand). The apps are built with exactly one of them.

| Folder | Brand |
|---|---|
| `tvsm/` | TV Station Manager (the original product style) |
| `ijmond360/` | IJmond360, taken from ijmond360.nl (active) |

## Choosing the brand
- `branding/active-brand` holds the name of the brand the apps are built with.
- The `TVSM_BRAND` environment variable overrides it for one build, e.g. `TVSM_BRAND=tvsm pnpm build`.
- Vite resolves `@brand/...` to the active brand folder (see `brand.mjs`).

## What a brand folder contains
Every brand must provide the same files, so switching is only a matter of changing `active-brand`:

- `BRAND.md`: the guidelines (colours, type, logo use). Shipped in the .deb under `/usr/share/doc`.
- `tokens.css` (+ `tokens.json`): the design tokens. Every brand defines the same `--tvsm-*` variables (`primary`, `primary-light`, `primary-dark`, `accent`, `on-air`, status colours, light and dark surfaces, sidebar, fonts (`sans`, `display` for page titles, `mono`), radii, shadow). Fonts must be self-hosted: add the `@fontsource` package to `packages/ui` and import it in `packages/ui/src/styles.css`.
- `logo.svg`, `logo-on-dark.svg`, `logo-on-light.svg`, `logo-mark.svg`, `favicon.svg`.

UI code never hard-codes brand colours: use the Tailwind classes from `packages/ui/src/styles.css` (`bg-brand`, `text-onair`, ...), `var(--tvsm-*)`, or `brandColor("primary")` from `@tvsm/ui` when a hex value is needed.
