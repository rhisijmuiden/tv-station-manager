# IJmond360 house style

House style of IJmond360, the regional public broadcaster for the IJmond (Velsen, Beverwijk, Heemskerk). Taken from [ijmond360.nl](https://ijmond360.nl): colours from the site theme, fonts from the site, logo traced from the site logo. All apps in this repo use it through `packages/ui`, which imports `tokens.css`.

## Logo
- `logo.svg` / `logo-on-light.svg`: the wordmark "ijmond 360", "ijmond" in IJmond Purple, the "o" and "360" in IJmond Pink. For light backgrounds.
- `logo-on-dark.svg`: same wordmark with "ijmond" in white. For the sidebar, login page and other dark backgrounds.
- `logo-mark.svg`: the app icon. Pink ring and white "360" on a purple rounded square (as the site's app icon).
- `favicon.svg`: the pink ring on purple, readable at 16 px.
- The SVGs are traced from the 468 px logo on the website. If IJmond360 supplies the original vector logo, replace the files with it (same names, same viewBox ratio).
- Keep clear space of at least the height of the "o" around the logo. Do not recolour or stretch it.

## Colours
| Token | Hex | Use |
|---|---|---|
| IJmond Purple | `#713C80` | Primary actions, links, focus, active menu item |
| Purple Light / Dark | `#8E55A0` / `#5A2E66` | Gradients, hover and pressed states |
| IJmond Pink | `#E92E7F` | Accent and the **on air** state |
| Aubergine | `#2A1430` | Sidebar, dark surfaces |
| Danger | `#DC2F45` | Destructive actions, errors |
| Info | `#2FA6DF` | Information (the site's light blue) |
| Success / Warning | `#1DB97A` / `#F5A524` | Healthy / attention needed |

In the dark theme the primary colour becomes `#9A5BAE`, because the brand purple has too little contrast on a dark background. The sidebar is always dark.

**Rule:** pink means *on air* or highlights one thing per screen. Use purple for everything else that is interactive.

## Typography
- UI text: **Inter** (variable), the body font of ijmond360.nl. Self-hosted so appliances work offline.
- Page titles: **Epilogue** (variable), the heading font of ijmond360.nl (`--tvsm-font-display`).
- Timecode, IDs, versions, logs: **JetBrains Mono**.

## Shape and depth
- Radius: 4 (inputs), 8 (buttons, cards), 12 (panels), 16 (dialogs). A bit squarer than the default style, like the website.
- Cards: surface colour, 1px border, soft shadow `--tvsm-shadow-card`.

## On-air graphics
The CasparCG overlay (`studio/casparcg-templates/tvsm/overlay.html`) uses the same colours: purple "up next" label, aubergine bars, pink ticker line.

## Layout
- Admin panels always have the menu on the **left**, collapsible on small screens.
- Bottom of the sidebar: Info button (version and updates), language switch (English / Nederlands), theme switch and user menu.
- All text is available in English (default) and Dutch.
