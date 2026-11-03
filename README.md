# Clickbeat

Ритм-игра для ПК от VegasDev: кидаешь любую песню, игра сама находит удары и темп и строит уровень на четыре сложности.

- `src/core.js` — разбор песни (удары, темп, сетка битов) и генератор карт
- `src/game.js` — игра, меню, отрисовка
- `src/page.html` — разметка и стили
- `scripts/build.js` — собирает `app/index.html` для программы и `web/clickbeat.html` для браузера
- `main.js`, `preload.js` — оболочка для Windows (Electron), поиск слов на lrclib.net

Сборка для Windows идёт в GitHub Actions и выкладывается в Releases с тегом `test`.
Шрифты Dela Gothic One и Onest — под лицензией SIL OFL (`app/fonts`).
