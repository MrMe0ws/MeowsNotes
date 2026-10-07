const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const desktopPin = require('./desktop-pin');
const widgetPlace = require('./widget-place');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.meowsnotes.app');

// Виджет встроен в рабочий стол и почти всегда перекрыт окнами. Chromium считает такое окно
// невидимым и перестаёт его рисовать, а для дочернего окна рабочего стола это состояние может
// не сняться даже после «Свернуть всё» — виджет застывает. Отключаем расчёт перекрытия.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, 'renderer');
const WIDGET_WIDTH = 320;
const WIDGET_HEIGHT = 300;
const WIDGET_MIN_WIDTH = 220;
const WIDGET_MAX_WIDTH = 1600;
const WIDGET_MIN_HEIGHT = 130;
const WIDGET_MAX_HEIGHT = 1400;
const WIDGET_TITLE = 'MeowsNotes — виджет';
const APP_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const FONT_SIZES = [12, 13, 14, 16, 18, 20];

// ---------- Хранилище ----------

const DEFAULT_SETTINGS = {
  autostart: true,
  // true — пользователь сам переключал автозапуск в меню; до этого он включается при каждом старте
  autostartChosen: false,
  widgetEnabled: true,
  widgetOnTop: false,
  widgetOpacity: 1,
  widgetBounds: null,
  widgetPlace: null,
  widgetWidth: WIDGET_WIDTH,
  widgetHeight: WIDGET_HEIGHT,
  fontSize: 14,
};

const clamp = (v, min, max, def) => Math.max(min, Math.min(max, Math.round(Number(v) || def)));
const clampWidth = (w) => clamp(w, WIDGET_MIN_WIDTH, WIDGET_MAX_WIDTH, WIDGET_WIDTH);
const clampHeight = (h) => clamp(h, WIDGET_MIN_HEIGHT, WIDGET_MAX_HEIGHT, WIDGET_HEIGHT);

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

// Запись через временный файл и rename: если питание пропадёт посреди записи,
// останется старая версия файла, а не обрезанная новая
function writeAtomic(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const file = dataPath(name);
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettingsNow, 400);
}

function writeSettingsNow() {
  clearTimeout(saveTimer);
  try {
    writeAtomic('settings.json', JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить настройки', e);
  }
}

let settings;

// ---------- Текст заметки ----------

// notes.txt — обычный UTF-8, его можно открыть Блокнотом. При каждом запуске предыдущая
// версия копируется в notes.backup.txt — на случай, если текст случайно стёрли.
const NOTE_FILE = 'notes.txt';
const NOTE_BACKUP = 'notes.backup.txt';

let noteText = '';
let noteDirty = false;
let noteTimer = null;

function loadNote() {
  try {
    noteText = fs.readFileSync(dataPath(NOTE_FILE), 'utf8');
  } catch {
    noteText = '';
  }
  if (noteText) {
    try {
      writeAtomic(NOTE_BACKUP, noteText);
    } catch (e) {
      console.error('Не удалось сделать резервную копию заметки', e);
    }
  }
}

function setNote(text) {
  if (typeof text !== 'string' || text === noteText) return;
  noteText = text;
  noteDirty = true;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(writeNoteNow, 500);
}

function writeNoteNow() {
  clearTimeout(noteTimer);
  if (!noteDirty) return;
  try {
    writeAtomic(NOTE_FILE, noteText);
    noteDirty = false;
    send('note-saved', Date.now());
  } catch (e) {
    console.error('Не удалось сохранить заметку', e);
    send('note-saved', null);
  }
}

function flushAll() {
  writeNoteNow();
  writeSettingsNow();
}

// ---------- Виджет ----------

let widgetWindow = null;
let tray = null;
let quitting = false;

function send(channel, data) {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send(channel, data);
}

function boundsVisible(b) {
  if (!b) return false;
  const area = screen.getDisplayMatching(b).workArea;
  return b.x < area.x + area.width - 40 && b.x + b.width > area.x + 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40;
}

// По умолчанию — левее MeowsConvert/MeowsClock, которые стоят в правом верхнем углу
function defaultWidgetBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = settings.widgetWidth;
  const height = Math.min(settings.widgetHeight, area.height - 48);
  const x = Math.max(area.x + 24, area.x + area.width - width - 24 - WIDGET_WIDTH - 24);
  return { x, y: area.y + 24, width, height };
}

// Запомненное место (монитор + отступ от края) и размер → прямоугольник под текущие экраны
function widgetPosition() {
  const width = settings.widgetWidth;
  const height = settings.widgetHeight;
  // Настройки старых версий: только абсолютные x, y
  const saved = settings.widgetBounds && { ...settings.widgetBounds, width, height };
  if (!settings.widgetPlace && boundsVisible(saved)) {
    settings.widgetPlace = widgetPlace.capture(saved);
    saveSettings();
  }
  return widgetPlace.resolve(settings.widgetPlace, width, height) || defaultWidgetBounds();
}

// Сохраняется только по действию пользователя (перетащил, растянул); перенастройка экранов место не трогает
function rememberWidgetPlace() {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  settings.widgetBounds = { x: b.x, y: b.y };
  settings.widgetPlace = widgetPlace.capture(b);
  saveSettings();
}

// После смены мониторов: виджет мог уехать на другой экран или поменять размер — ставим как было
function restoreWidgetPlace() {
  const win = widgetWindow;
  if (!win || win.isDestroyed() || resizeDrag) return;
  const b = win.getBounds();
  const target = widgetPosition();
  if (target.x !== b.x || target.y !== b.y || target.width !== b.width || target.height !== b.height) {
    desktopPin.setBounds(win, target);
  }
  desktopPin.raise(win);
}

function createWidget() {
  const bounds = widgetPosition();

  widgetWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    // При resizable: false Chromium фиксирует размер окна, и SetWindowPos закреплённого виджета
    // не может поменять размер. Системной рамки у прозрачного окна нет — размер меняют
    // «ручки» по краям и углам в самом виджете (widget-resize-*).
    resizable: true,
    minWidth: WIDGET_MIN_WIDTH,
    maxWidth: WIDGET_MAX_WIDTH,
    minHeight: WIDGET_MIN_HEIGHT,
    maxHeight: WIDGET_MAX_HEIGHT,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: settings.widgetOnTop,
    title: WIDGET_TITLE,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  const win = widgetWindow;
  win.setOpacity(settings.widgetOpacity);
  win.webContents.session.setSpellCheckerLanguages(['ru', 'en-US']);
  win.loadFile(path.join(RENDERER, 'widget.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    if (!settings.widgetOnTop) pinWidget(win);
  });
  // Страница меняет <title> — держим постоянный, по нему окно ищется при отладке
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('context-menu', (_e, params) => popupMenu(params));
  // Выключение/перезагрузка Windows: дописываем всё, не дожидаясь таймеров
  win.on('query-session-end', flushAll);
  win.on('session-end', flushAll);

  win.on('moved', rememberWidgetPlace);
  win.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null;
    // Окно закреплено внутри рабочего стола и погибает вместе с Explorer — поднимаем заново
    if (!quitting && settings.widgetEnabled && !widgetWindow) setTimeout(() => setWidgetEnabled(true), 2000);
  });
}

// Explorer может ещё не создать рабочий стол (ранний автозапуск) — пробуем повторно
function pinWidget(win, attempt = 0) {
  if (win.isDestroyed() || settings.widgetOnTop) return;
  if (desktopPin.pin(win)) return;
  if (attempt < 30) setTimeout(() => pinWidget(win, attempt + 1), 2000);
}

function setWidgetEnabled(on) {
  settings.widgetEnabled = on;
  if (on && !widgetWindow) createWidget();
  if (!on && widgetWindow) widgetWindow.close();
}

// Смена режима «на рабочем столе» ↔ «поверх окон» — проще пересоздать окно
function recreateWidget() {
  if (!widgetWindow) return;
  const old = widgetWindow;
  widgetWindow = null;
  old.destroy();
  createWidget();
}

function applyBounds(bounds) {
  if (widgetWindow) desktopPin.setBounds(widgetWindow, bounds);
}

// ---------- Автозапуск ----------

function loginItemOptions() {
  if (app.isPackaged) return { args: ['--autostart'] };
  // В режиме разработки запускаем electron.exe с путём к проекту
  return { path: process.execPath, args: [path.resolve(app.getAppPath()), '--autostart'] };
}

function applyAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: settings.autostart });
}

// ---------- Меню ----------

function commonMenuItems() {
  return [
    {
      label: 'Размер текста',
      submenu: FONT_SIZES.map((v) => ({
        label: `${v} px`,
        type: 'radio',
        checked: settings.fontSize === v,
        click: () => updateSettings({ fontSize: v }),
      })),
    },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: settings.widgetOnTop,
      click: (item) => updateSettings({ widgetOnTop: item.checked }),
    },
    {
      label: 'Прозрачность',
      submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(settings.widgetOpacity - v) < 0.01,
        click: () => updateSettings({ widgetOpacity: v }),
      })),
    },
    { label: 'Вернуть в угол экрана', click: () => updateSettings({ widgetBounds: null }) },
    {
      label: 'Стандартный размер',
      enabled: settings.widgetWidth !== WIDGET_WIDTH || settings.widgetHeight !== WIDGET_HEIGHT,
      click: () => updateSettings({ widgetWidth: WIDGET_WIDTH, widgetHeight: WIDGET_HEIGHT }),
    },
    { type: 'separator' },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: settings.autostart,
      click: (item) => updateSettings({ autostart: item.checked, autostartChosen: true }),
    },
  ];
}

// Правый клик в поле текста — правка и орфография, в остальных местах — меню виджета
function popupMenu(params = null) {
  if (!widgetWindow) return;
  const wc = widgetWindow.webContents;
  const edit = [];
  if (params && params.isEditable) {
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 5)) {
        edit.push({ label: word, click: () => wc.replaceMisspelling(word) });
      }
      if (!params.dictionarySuggestions.length) edit.push({ label: 'Нет вариантов', enabled: false });
      edit.push(
        { label: 'Добавить в словарь', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: 'separator' }
      );
    }
    const f = params.editFlags;
    edit.push(
      { label: 'Отменить', role: 'undo', enabled: f.canUndo },
      { label: 'Повторить', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut', enabled: f.canCut },
      { label: 'Копировать', role: 'copy', enabled: f.canCopy },
      { label: 'Вставить', role: 'paste', enabled: f.canPaste },
      { label: 'Выделить всё', role: 'selectAll', enabled: f.canSelectAll },
      { type: 'separator' },
      { label: 'Виджет', submenu: [...commonMenuItems(), { type: 'separator' }, ...hideItems()] }
    );
    Menu.buildFromTemplate(edit).popup({ window: widgetWindow });
    return;
  }
  Menu.buildFromTemplate([...commonMenuItems(), { type: 'separator' }, ...hideItems()]).popup({ window: widgetWindow });
}

function hideItems() {
  return [
    { label: 'Скрыть виджет', click: () => updateSettings({ widgetEnabled: false }) },
    { label: 'Выход', click: () => app.quit() },
  ];
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Виджет на рабочем столе',
        type: 'checkbox',
        checked: settings.widgetEnabled,
        click: (item) => updateSettings({ widgetEnabled: item.checked }),
      },
      ...commonMenuItems(),
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
  );
}

function createTray() {
  tray = new Tray(path.join(ASSETS, process.platform === 'win32' ? 'tray.ico' : 'icon-small.png'));
  tray.setToolTip('MeowsNotes — заметки');
  tray.on('click', () => updateSettings({ widgetEnabled: true }));
  buildTrayMenu();
}

// ---------- Настройки ----------

function updateSettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, patch);

  if ('autostart' in patch && patch.autostart !== prev.autostart) applyAutostart();
  if ('widgetEnabled' in patch && patch.widgetEnabled !== prev.widgetEnabled) setWidgetEnabled(patch.widgetEnabled);
  if ('widgetOnTop' in patch && patch.widgetOnTop !== prev.widgetOnTop) recreateWidget();
  if ('widgetOpacity' in patch && widgetWindow) widgetWindow.setOpacity(settings.widgetOpacity);
  if ('fontSize' in patch && !FONT_SIZES.includes(settings.fontSize)) settings.fontSize = DEFAULT_SETTINGS.fontSize;
  if ('widgetWidth' in patch || 'widgetHeight' in patch) {
    settings.widgetWidth = clampWidth(settings.widgetWidth);
    settings.widgetHeight = clampHeight(settings.widgetHeight);
    if (widgetWindow) {
      const b = widgetWindow.getBounds();
      // Сохраняем правый верхний угол — виджет по умолчанию стоит у правой стороны экрана
      applyBounds({ x: b.x + b.width - settings.widgetWidth, y: b.y, width: settings.widgetWidth, height: settings.widgetHeight });
      rememberWidgetPlace();
    }
  }
  if ('widgetBounds' in patch && patch.widgetBounds === null) {
    settings.widgetPlace = null;
    applyBounds(defaultWidgetBounds());
  }

  saveSettings();
  buildTrayMenu();
  send('settings', settings);
  return settings;
}

// ---------- IPC ----------

ipcMain.handle('get-state', () => ({ settings, text: noteText, version: app.getVersion() }));
ipcMain.handle('set-settings', (_e, patch) => updateSettings(patch));
ipcMain.on('note-text', (_e, text) => setNote(text));
ipcMain.on('note-flush', writeNoteNow);
ipcMain.on('widget-menu', () => popupMenu());

// Растягивание за край или угол: renderer присылает смещение мыши от начала перетаскивания.
// edge — сочетание букв l/r/t/b; противоположные края остаются на месте.
let resizeDrag = null;

ipcMain.on('widget-resize-start', () => {
  if (widgetWindow) resizeDrag = widgetWindow.getBounds();
});

ipcMain.on('widget-resize-move', (_e, { edge, dx, dy }) => {
  if (!widgetWindow || !resizeDrag || typeof edge !== 'string') return;
  const s = resizeDrag;
  let { x, y, width, height } = s;
  if (edge.includes('r')) width = clampWidth(s.width + dx);
  if (edge.includes('l')) {
    width = clampWidth(s.width - dx);
    x = s.x + s.width - width;
  }
  if (edge.includes('b')) height = clampHeight(s.height + dy);
  if (edge.includes('t')) {
    height = clampHeight(s.height - dy);
    y = s.y + s.height - height;
  }
  settings.widgetWidth = width;
  settings.widgetHeight = height;
  applyBounds({ x, y, width, height });
});

ipcMain.on('widget-resize-end', () => {
  if (!widgetWindow || !resizeDrag) return;
  resizeDrag = null;
  rememberWidgetPlace();
  buildTrayMenu();
});

// ---------- Жизненный цикл ----------

app.on('second-instance', () => updateSettings({ widgetEnabled: true }));

app.on('before-quit', () => {
  quitting = true;
  flushAll();
});

app.on('window-all-closed', () => {
  // Приложение продолжает жить в трее
});

app.whenReady().then(() => {
  settings = { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
  settings.widgetWidth = clampWidth(settings.widgetWidth);
  settings.widgetHeight = clampHeight(settings.widgetHeight);
  if (!FONT_SIZES.includes(settings.fontSize)) settings.fontSize = DEFAULT_SETTINGS.fontSize;

  // Пока пользователь не выключил автозапуск сам, прописываем его при каждом старте, чтобы заметки
  // были на месте после перезагрузки. Запись в реестре одна (по AppUserModelId), поэтому установленная
  // версия перезаписывает запись dev-запуска. После ручного выбора — синхронизируем с системой.
  if (!settings.autostartChosen) {
    settings.autostart = true;
    applyAutostart();
    saveSettings();
  } else if (process.platform === 'win32') {
    settings.autostart = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  }

  loadNote();
  createTray();
  if (settings.widgetEnabled) createWidget();
  widgetPlace.watchDisplays(restoreWidgetPlace);
});
