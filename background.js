// Клик по иконке → выгрузка в Excel. Правый клик по иконке → меню с выбором формата (Excel / CSV).
// Скрипты внедряются во вкладку в изолированный мир контент-скрипта.
// activeTab даёт доступ только к текущей вкладке и только после клика пользователя
// (по иконке или по пункту её контекстного меню).

const MENU = { 'export-xlsx': 'xlsx', 'export-csv': 'csv' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'export-xlsx', title: 'Выгрузить в Excel (.xlsx)', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'export-csv', title: 'Выгрузить в CSV', contexts: ['action'] });
  });
});

chrome.action.onClicked.addListener((tab) => runExport(tab, 'xlsx'));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (MENU[info.menuItemId] && tab) runExport(tab, MENU[info.menuItemId]);
});

async function runExport(tab, format) {
  if (!tab.id || !/^https?:/.test(tab.url || '')) return;
  try {
    // Формат передаём через глобальную переменную изолированного мира: файлам executeScript аргументы не передать.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (f) => {
        if (!window.__primoExportRunning) window.__primoExportFormat = f;
      },
      args: [format],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['xlsx-writer.js', 'csv-writer.js', 'exporter.js'],
    });
  } catch (e) {
    console.error('Primo logs export: не удалось внедрить скрипт', e);
    chrome.action.setBadgeBackgroundColor({ color: '#d32f2f', tabId: tab.id });
    chrome.action.setBadgeText({ text: 'ERR', tabId: tab.id });
    chrome.action.setTitle({ title: 'Ошибка: ' + (e && e.message ? e.message : e), tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 15000);
  }
}

// Сохранение готового файла. Скачивание через chrome.downloads не попадает под ограничение Chrome
// на повторные автоматические скачивания со страницы, которое снимается только перезагрузкой.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'primo-download') return;
  // Принимаем только blob-ссылку, созданную на той же вкладке, и только .xlsx / .csv.
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab ||
    typeof msg.url !== 'string' ||
    !msg.url.startsWith('blob:' + origin + '/') ||
    typeof msg.filename !== 'string' ||
    !/\.(xlsx|csv)$/i.test(msg.filename)
  ) {
    sendResponse({ ok: false, error: 'некорректный запрос на сохранение' });
    return;
  }
  chrome.downloads
    .download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' })
    .then((id) => sendResponse({ ok: true, id }))
    .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // ответ асинхронный
});
