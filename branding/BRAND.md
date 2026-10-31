# TV Station Manager house style

This is the house style for TV Station Manager. All apps in this repo (orchestrator, management node, studio node UI) use it through `packages/ui`, which imports `tokens.css`.

## Idea
A broadcast control room: calm, dark navigation, bright content, and one unmistakable signal colour for anything that is **on air**.

## Logo
- `logo.svg`: full logo (mark + wordmark), wordmark in `currentColor` for inline SVG use.
- `logo-on-dark.svg` / `logo-on-light.svg`: full logo with a fixed white or ink wordmark, for use as an image.
- `logo-mark.svg` / `favicon.svg`: the mark only. A screen with a play symbol and a red "on air" tally light.
- Keep clear space of at least the height of the tally light around the logo. Do not recolour the mark.

## Colours
| Token | Hex | Use |
|---|---|---|
| Signal Blue | `#3B6CFF` | Primary actions, links, focus, active menu item |
| Signal Blue Light / Dark | `#5B8CFF` / `#2F4FE0` | Gradients, hover and pressed states |
| On Air Red | `#FF3D57` | Live / on-air state and destructive actions only |
| Ink | `#0A0E1A` | Sidebar, dark surfaces |
| Success | `#1DB97A` | Healthy, online, completed |
| Warning | `#F5A524` | Degraded, attention needed |

Light and dark themes are both defined in `tokens.css` (`data-theme="dark"` on `<html>`). The sidebar is always dark.

**Rule:** red means *on air* or *danger*. Never use it for decoration.

## Typography
- UI: **Inter** (variable), self-hosted so appliances work offline.
- Timecode, IDs, versions, logs: **JetBrains Mono**.
- Page title 24/32 semibold, section title 16/24 semibold, body 14/20, small 12/16.

## Shape and depth
- Radius: 6 (inputs), 10 (buttons, cards), 14 (panels), 20 (dialogs).
- Cards: surface colour, 1px border, soft shadow `--tvsm-shadow-card`.

## Layout
- Admin panels always have the menu on the **left**, collapsible on small screens.
- Bottom of the sidebar: Info button (version and updates), language switch (English / Nederlands), theme switch and user menu.
- All text is available in English (default) and Dutch.
