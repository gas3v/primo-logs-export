// Генератор CSV для Excel с русской локалью.
// window.__primoCsv.build({ columns:[{title,type}], rows:[[...]] }) → Blob
// - разделитель «;» (в русской локали Excel «,» — десятичный разделитель);
// - UTF-8 с BOM: без BOM Excel открывает файл в кодировке Windows-1251 и портит кириллицу;
// - строки разделены CRLF, поля с ; " CR LF берутся в кавычки, кавычки удваиваются;
// - даты как в xlsx: «дд.мм.гггг чч:мм:сс.000», без пересчёта часового пояса.
(() => {
  if (window.__primoCsv) return;

  const SEP = ';';

  // "2026-11-05T13:25:26.121223" → "05.11.2026 13:25:26.121"
  function formatDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(v || '');
    if (!m) return v;
    const ms = ((m[7] || '') + '000').slice(0, 3);
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}.${ms}`;
  }

  function field(v, type) {
    if (v === null || v === undefined) return '';
    let s = type === 'date' ? formatDate(v) : String(v);
    s = s.replace(/\u0000/g, '');
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function build({ columns, rows }) {
    const lines = [columns.map((c) => field(c.title)).join(SEP)];
    for (const row of rows) lines.push(columns.map((c, i) => field(row[i], c.type)).join(SEP));
    return new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  }

  window.__primoCsv = { build };
})();
