const $ = (sel) => document.querySelector(sel);
const note = $('#note');

// ---------- Текст ----------

// Каждое изменение сразу уходит в main: он пишет файл с задержкой и дописывает его при выходе,
// поэтому текст не теряется, даже если окно закроется посреди набора
note.addEventListener('input', () => window.api.setText(note.value));

note.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    // Табуляция в тексте вместо перехода фокуса; execCommand сохраняет историю Ctrl+Z
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  } else if (e.key === 'Escape') {
    note.blur();
  } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    window.api.flush();
  }
});

// ---------- Кнопки ----------

let copyTimer = null;
$('#w-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(note.value);
  } catch {
    return;
  }
  const btn = $('#w-copy');
  btn.classList.add('done');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => btn.classList.remove('done'), 1200);
});

$('#w-menu').addEventListener('click', () => window.api.widgetMenu());

// ---------- Размер: края и углы ----------

// Смещение считаем по screenX/screenY — они не зависят от того, что окно под курсором
// само двигается и меняет размер.
for (const grip of document.querySelectorAll('.grip')) {
  let start = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = { x: e.screenX, y: e.screenY };
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    document.body.style.setProperty('--resize-cursor', getComputedStyle(grip).cursor);
    document.body.classList.add('resizing');
    window.api.resizeStart();
  });
  grip.addEventListener('pointermove', (e) => {
    if (start) window.api.resizeMove(grip.dataset.edge, e.screenX - start.x, e.screenY - start.y);
  });
  const finish = () => {
    if (!start) return;
    start = null;
    grip.classList.remove('active');
    document.body.classList.remove('resizing');
    window.api.resizeEnd();
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('lostpointercapture', finish);
}

// ---------- Настройки ----------

function applySettings(s) {
  document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
}

(async () => {
  const s = await window.api.getState();
  applySettings(s.settings);
  note.value = s.text;
  window.api.on('settings', applySettings);
  // Статус показываем только при ошибке записи; после удачной записи он снова пропадает
  window.api.on('note-saved', (ts) => {
    $('#status').textContent = ts ? '' : 'Не удалось сохранить';
  });
})();
