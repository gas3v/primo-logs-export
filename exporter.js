// Выгрузка событий операции робота Primo Orchestrator в .xlsx или .csv.
// Запускается по клику на иконку расширения в изолированном мире контент-скрипта (world: ISOLATED):
// DOM, localStorage и Performance API страницы здесь доступны, а chrome.runtime нужен для сохранения файла.
// Формат задаёт background.js в window.__primoExportFormat перед внедрением ('xlsx' | 'csv').
(async () => {
  if (window.__primoExportRunning) return;
  window.__primoExportRunning = true;
  const FORMAT = window.__primoExportFormat === 'csv' ? 'csv' : 'xlsx';

  const PAGE_SIZE = 1000;
  const API = '/api/robotlogs/OperationEvents/';
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // ---------- уведомление на странице ----------
  const toast = document.createElement('div');
  toast.style.cssText =
    'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:420px;padding:12px 16px;' +
    'border-radius:10px;font:14px/1.4 system-ui,sans-serif;color:#fff;background:#6b2fd6;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.25);white-space:pre-line';
  const msg = toast.appendChild(document.createElement('div'));
  document.body.appendChild(toast);
  const say = (t) => (msg.textContent = t);
  const COLORS = { ok: '#2e7d32', warn: '#e65100', error: '#d32f2f' };
  // kind: ok | warn | error. download: {url, fileName, label} — кнопка ручного скачивания.
  // Клик по кнопке — жест пользователя на странице, такое скачивание Chrome не блокирует.
  const finish = (t, kind, download) => {
    say(t);
    toast.style.background = COLORS[kind];
    toast.style.cursor = 'pointer';
    toast.title = 'Закрыть';
    toast.onclick = () => toast.remove();
    if (download) {
      const btn = toast.appendChild(document.createElement('button'));
      btn.textContent = download.label;
      btn.style.cssText =
        'margin-top:10px;padding:6px 14px;border:0;border-radius:6px;background:#fff;color:#222;' +
        'font:600 14px system-ui,sans-serif;cursor:pointer';
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const a = document.createElement('a');
        a.href = download.url;
        a.download = download.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }
    // Предупреждение с кнопкой не исчезает само: пользователь должен успеть скачать файл.
    if (kind !== 'warn') setTimeout(() => toast.remove(), kind === 'error' ? 12000 : 15000);
    window.__primoExportRunning = false;
  };

  try {
    // ---------- токен ----------
    let token = null;
    const raw = localStorage.getItem('token');
    if (raw) {
      try {
        const j = JSON.parse(raw);
        token = typeof j === 'string' ? j : j.token || j.accessToken || j.access_token;
      } catch {
        token = raw;
      }
    }
    if (!token) throw new Error('Не найден токен авторизации. Войдите в оркестратор и повторите.');
    const headers = { Authorization: 'Bearer ' + token };

    // ---------- операция и фильтры ----------
    const pageUrl = new URL(location.href);
    const pathOp = (pageUrl.pathname.match(GUID) || [])[0];

    // Последний запрос страницы к OperationEvents (для этой операции).
    const lastApi = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes(API) && (!pathOp || n.toLowerCase().includes(pathOp.toLowerCase())))
      .pop();

    const operationKey = pathOp || (lastApi && (new URL(lastApi).pathname.match(GUID) || [])[0]);
    if (!operationKey)
      throw new Error('Это не страница событий операции робота.\nОткройте «Робот → операция → события» и повторите.');

    const params = buildParams(pageUrl, lastApi);
    params.delete('pageNumber');
    params.delete('pageSize');

    // ---------- справочник типов событий ----------
    say('Загружаю справочник событий…');
    const typeNames = new Map();
    try {
      const r = await fetch(`/api/robotlogs/OperationEventTypes/${operationKey}`, { headers });
      if (r.ok) for (const t of await r.json()) typeNames.set(`${t.source}:${t.event}`, (t.names || []).join(', '));
    } catch {
      /* не критично */
    }

    // ---------- постраничная загрузка ----------
    const all = [];
    let total = null;
    let projectName = '';
    const started = Date.now();
    for (let page = 0; ; page++) {
      params.set('pageNumber', page);
      params.set('pageSize', PAGE_SIZE);
      const r = await fetch(`${API}${operationKey}?${params}`, { headers });
      if (r.status === 401) throw new Error('Сессия истекла (401). Перезайдите в оркестратор и повторите.');
      if (!r.ok) throw new Error(`Ошибка API: HTTP ${r.status}`);
      const j = await r.json();
      const chunk = j.result || [];
      total = j.filterCount ?? j.totalCount ?? total;
      projectName = projectName || j.projectName || '';
      all.push(...chunk);
      // Сервер отдаёт ~1000 событий за 2–5 с, поэтому большие операции грузятся минуту и дольше.
      let eta = '';
      if (total != null && all.length < total) {
        const left = Math.ceil(((Date.now() - started) / all.length) * (total - all.length) / 1000);
        eta = left >= 60 ? `\nОсталось примерно ${Math.ceil(left / 60)} мин` : `\nОсталось примерно ${left} с`;
      }
      say(`Загружено событий: ${all.length}${total != null ? ' из ' + total : ''}…${eta}`);
      if (chunk.length < PAGE_SIZE || (total != null && all.length >= total)) break;
    }

    if (!all.length) {
      finish('Нет событий для выгрузки с текущими фильтрами.', 'error');
      return;
    }

    // ---------- формирование таблицы ----------
    say(`Формирую ${FORMAT === 'csv' ? 'CSV' : 'Excel'} (${all.length} строк)…`);
    const clean = (s) => (s == null ? '' : String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').trim());
    const SOURCE = { 0: 'Робот', 1: 'Оркестратор' };

    const columns = [
      { title: 'Дата события', width: 24, type: 'date' },
      { title: 'Источник', width: 13 },
      { title: 'Событие', width: 30 },
      { title: 'ElementName', width: 28 },
      { title: 'Сообщение', width: 70 },
      { title: 'ElementId', width: 38 },
      { title: 'ElementClass', width: 34 },
      { title: 'Полный текст', width: 70 },
      { title: 'Проект', width: 22 },
      { title: 'Робот', width: 16 },
      { title: 'Агент', width: 26 },
      { title: 'Пользователь', width: 14 },
      { title: 'EntityId', width: 38 },
      { title: 'Код события', width: 12, type: 'number' },
      { title: 'Время в оркестраторе', width: 24, type: 'date' },
      { title: 'Снимок экрана', width: 30 },
      { title: 'Подпись корректна', width: 12 },
      { title: 'Id', width: 38 },
    ];

    const rows = all.map((e) => [
      e.eventDate,
      SOURCE[e.source] ?? e.source,
      typeNames.get(`${e.source}:${e.event}`) || String(e.event ?? ''),
      clean(e.parsedElementName),
      clean(e.parsedMessage ?? e.text),
      clean(e.parsedElementId),
      clean(e.parsedElementClass),
      clean(e.text),
      e.projectName || projectName,
      e.robotName,
      e.workerName,
      e.userName,
      e.entityId,
      e.event,
      e.orchTimestampUtc,
      e.screenFilePath,
      e.correctSignature == null ? '' : e.correctSignature ? 'Да' : 'Нет',
      e.id,
    ]);

    const robotName =
      all.find((e) => e.robotName)?.robotName ||
      decodeURIComponent(pageUrl.pathname.split(operationKey)[1]?.split('/')[1] || '');
    const stamp = localIso(new Date()).replace(/[-:]/g, '').replace('T', '_');
    const fileName = ['logs', robotName, projectName, operationKey.slice(0, 8), stamp]
      .filter(Boolean)
      .join('_')
      .replace(/[\\/:*?"<>|\s]+/g, '_') + '.' + FORMAT;

    const blob =
      FORMAT === 'csv'
        ? window.__primoCsv.build({ columns, rows })
        : window.__primoXlsx.build({ sheetName: 'Логи', columns, rows });
    const url = URL.createObjectURL(blob);
    // Ссылка живёт 10 минут: её использует chrome.downloads (в т. ч. пока открыт диалог «Сохранить как»)
    // и кнопка ручного скачивания на плашке.
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);

    // Сохраняем через chrome.downloads в service worker. Скачивание через <a download> со страницы
    // Chrome блокирует, если на этой странице уже было скачивание без жеста пользователя
    // («Сайт пытается скачать несколько файлов»), — до перезагрузки страницы.
    say('Сохраняю файл…');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'primo-download', url, filename: fileName });
    } catch (e) {
      res = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (res && res.ok) {
      finish(`Готово: ${all.length} событий → ${fileName}`, 'ok', { url, fileName, label: 'Скачать ещё раз' });
    } else {
      console.warn('Primo logs export: chrome.downloads не сохранил файл', res);
      finish(
        `Файл сформирован (${all.length} событий), но автоматически не сохранён` +
          (res && res.error ? `:\n${res.error}` : '.') +
          '\nНажмите «Скачать файл».',
        'warn',
        { url, fileName, label: 'Скачать файл' }
      );
    }
  } catch (err) {
    console.error('Primo logs export:', err);
    finish('Не удалось выгрузить логи:\n' + (err && err.message ? err.message : err), 'error');
  }

  // Параметры запроса: из фильтров в адресе страницы (актуальное состояние),
  // иначе — из последнего запроса страницы к API.
  function buildParams(pageUrl, lastApi) {
    const f = pageUrl.searchParams.get('filters');
    if (f) {
      try {
        const filters = JSON.parse(decodeURIComponent(atob(f)));
        const p = new URLSearchParams();
        const map = {
          entityId: 'EntityId',
          parsedElementName: 'ParsedElementName',
          parsedElementId: 'ParsedElementId',
          parsedElementClass: 'ParsedElementClass',
          parsedMessage: 'ParsedMessage',
        };
        for (const [k, apiKey] of Object.entries(map)) if (filters[k]) p.set(apiKey, filters[k]);
        if (filters.withScreenFile) p.set('WithScreenFile', 'true');
        if (Array.isArray(filters.eventDate)) {
          if (filters.eventDate[0]) p.set('eventDate1', localIso(filters.eventDate[0]));
          if (filters.eventDate[1]) p.set('eventDate2', localIso(filters.eventDate[1]));
        }
        return p;
      } catch {
        /* упадём на запасной вариант */
      }
    }
    return lastApi ? new URL(lastApi).searchParams : new URLSearchParams();
  }

  // ISO UTC → локальное время браузера без зоны, как это делает UI оркестратора
  function localIso(v) {
    const d = new Date(v);
    if (isNaN(d)) return v;
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
  }
})();
