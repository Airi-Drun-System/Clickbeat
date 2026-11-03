'use strict';
// Собирает игру в один HTML: app/index.html для программы (шрифты свои, без интернета)
// и web/clickbeat.html для браузерной версии (шрифты с Google Fonts).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const page = read('src/page.html');
const scripts = (html) => html
  .replace('<script>/*CORE*/</script>', () => `<script>\n${read('src/core.js')}\n</script>`)
  .replace('<script>/*GAME*/</script>', () => `<script>\n${read('src/game.js')}\n</script>`);
const fontLinks = /<link rel="preconnect"[^>]*>\s*<link rel="preconnect"[^>]*>\s*<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/;
if (!fontLinks.test(page)) throw new Error('В page.html не нашлись ссылки на шрифты');

const faces = [['Dela Gothic One', 'dela-gothic-one', [400]], ['Onest', 'onest', [400, 500, 600, 700, 800]]]
  .flatMap(([family, file, weights]) => weights.flatMap((w) => [
    `@font-face{font-family:"${family}";font-weight:${w};font-display:block;src:url(fonts/${file}-cyrillic-${w}-normal.woff2) format("woff2");unicode-range:U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}`,
    `@font-face{font-family:"${family}";font-weight:${w};font-display:block;src:url(fonts/${file}-latin-${w}-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}`,
  ])).join('\n');

const app = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'">
<style>${faces}</style>
${scripts(page.replace(fontLinks, ''))}
</html>
`;
fs.mkdirSync(path.join(root, 'app'), { recursive: true });
fs.writeFileSync(path.join(root, 'app/index.html'), app);

fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web/clickbeat.html'), scripts(page));
console.log('build: app/index.html, web/clickbeat.html');
