# Editor guide and Help link

The management app ships a step-by-step guide for editors (in Dutch): filling the week planning, filling hour blocks, planning a live broadcast, and how recordings work. It has screenshots, four short videos and progress checkboxes.

- Location: `apps/management/web/public/help/` (`index.html`, `img/`, `video/`). Vite copies `web/public` into `dist/web`, so the platform server serves it at `/help/index.html`. Videos support range requests, so seeking works.
- The sidebar shows a **Help** link ("Handleiding" in Dutch) above the Info button. It opens the guide in a new tab. Any app can turn it on with `mountPlatformApp({ helpUrl })`. Apps without `helpUrl` show no link.
- The page is static and public, like the login page. It contains only demo data.
- The page loads the Inter and JetBrains Mono fonts from Google Fonts. Offline it falls back to system fonts.

## Updating after UI changes

The screenshots and videos come from a local management server with demo data and Playwright: screenshots at 1600x1000 with deviceScaleFactor 2, and videos made with `recordVideo` and converted to H.264 MP4 with ffmpeg. Images are resized to 1760 px wide (JPEG quality 76) to keep the folder small. Replace the files in `img/` and `video/` with the same names, then edit the text in `index.html`.
