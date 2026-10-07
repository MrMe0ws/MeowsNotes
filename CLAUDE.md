# MeowsNotes — заметки для разработки

Виджет заметок на Electron. Стиль, механика окна и закрепления на рабочем столе взяты
из соседних `../MeowsConvert` (там подробный CLAUDE.md про `desktop-pin.js` — правила те же) и `../MeowsClock`.
Главного окна нет: только виджет и трей. Одна заметка — одно текстовое поле.

## Структура

```
src/
  main.js            трей, виджет, текст заметки, автозапуск, настройки, меню, IPC
  desktop-pin.js     встраивание виджета в рабочий стол (SetParent в Progman/WorkerW через koffi), копия из MeowsClock
  preload.js         window.api, белый список каналов main → renderer в CHANNELS
  renderer/
    widget.html/js/css  шапка, textarea, ручки размера по краям и углам
scripts/
  make-icon.js       рисует иконку кодом (листок с ушками) → assets/*.png|ico, build/icon.ico
  start.js           запуск без ELECTRON_RUN_AS_NODE
```

## Команды

- `npm start` — запуск; `npm run icon` — перерисовать иконки; `npm run dist` — установщик NSIS.
- UI проверять через `npm start -- --remote-debugging-port=9334` и CDP (`Runtime.evaluate`,
  `Input.insertText`, `Page.captureScreenshot`): закреплённый виджет перекрыт окнами, скриншот экрана его не видит.
  Ресайз можно дёргать из CDP: `api.resizeStart(); api.resizeMove('br', 80, 120); api.resizeEnd()`.

## Архитектура

- **Текст — единственное, что нельзя потерять.** Хранится в main (`noteText`), renderer шлёт `note-text`
  на каждый `input`. Запись в `%APPDATA%\MeowsNotes\notes.txt` через 500 мс после последнего изменения,
  при `before-quit` и при `query-session-end`/`session-end` окна (выключение Windows). Пишется атомарно
  (`writeAtomic`: `.tmp` + `rename`). При старте непустой `notes.txt` копируется в `notes.backup.txt`.
  После записи main шлёт `note-saved` (время или `null` при ошибке); в шапке показывается только ошибка, успешная запись ничего не пишет.
- Настройки (`DEFAULT_SETTINGS`) в `settings.json` там же, запись с задержкой 400 мс; renderer читает их
  через `get-state` (вместе с текстом), меняет через `set-settings`, main рассылает `settings`.
- **Размер окна задаёт пользователь**, а не содержимое (в отличие от MeowsClock). Ручки `.grip` с
  `data-edge` из букв `l/r/t/b`; renderer шлёт `widget-resize-start/move/end` со смещением `screenX/screenY`
  от начала перетаскивания, main считает от bounds на старте, противоположные края стоят на месте.
  Сохраняются `widgetWidth`, `widgetHeight`, `widgetBounds {x, y}`.
- **Автозапуск** включён по умолчанию: пока `autostartChosen` не стал `true` (пользователь щёлкнул пункт меню),
  он прописывается при каждом старте. Запись в `HKCU\...\Run` одна, по имени `com.meowsnotes.app`, поэтому
  установленная версия перезаписывает запись dev-запуска (и наоборот — `npm start` перепишет её на electron.exe).
- Контекстное меню строит main в `webContents.on('context-menu')`: в поле текста — орфография (`ru`, `en-US`)
  и правка, иначе — меню виджета. В renderer `contextmenu` не перехватывать, иначе событие до main не дойдёт.

## Подводные камни

- **`resizable: true` у виджета обязателен** — иначе `SetWindowPos` закреплённого окна не меняет размер.
  Пределы — `minWidth/maxWidth/minHeight/maxHeight` (`WIDGET_MIN_*`/`WIDGET_MAX_*`) и `clampWidth/clampHeight`.
- Всё остальное — как в MeowsConvert: `CalculateNativeWinOcclusion` отключён, `backgroundThrottling: false`,
  двигать закреплённое окно только через `desktopPin.setBounds`, пересоздание после перезапуска Explorer
  (текст при этом берётся из памяти main). Стиль `WS_CHILD` не ставить — пропадёт ввод с клавиатуры.
- **ELECTRON_RUN_AS_NODE.** Терминал VS Code выставляет эту переменную — запускать через `npm start`
  или из Проводника, иначе exe молча завершается.
- Настройки и текст dev-запуска и установленной версии общие (`%APPDATA%\MeowsNotes`), single-instance lock тоже —
  перед `npm start` закрыть установленную копию. **Не удалять `notes.txt` при тестах — там реальные заметки.**
- Поиск окна при отладке: дочернее окно Progman с заголовком `MeowsNotes — виджет`.

## Место виджета при смене мониторов

- `src/widget-place.js` (одинаковый в MeowsClock, MeowsConvert, Notes, TempCPU) хранит в `settings.widgetPlace`
  монитор (`display.id`, запасной ключ — `label`) и отступ от ближайших краёв его рабочей области. Абсолютные
  `widgetBounds` оставлены для совместимости: из них при первом запуске строится `widgetPlace`.
  Без этого смена масштаба/разрешения/расположения экранов уводила виджет на соседний монитор.
- Место сохраняется только по действию пользователя (`moved`, конец растягивания) через `rememberWidgetPlace`.
- `watchDisplays` на `display-added/removed/metrics-changed`, выход из сна и разблокировку вызывает
  `restoreWidgetPlace` трижды (0,3 / 1,5 / 4 с): Explorer растягивает Progman не сразу, а Chromium после смены DPI
  сам двигает и масштабирует дочернее окно. Если монитора нет — тот же угол основного экрана, сохранённое место не меняется.
