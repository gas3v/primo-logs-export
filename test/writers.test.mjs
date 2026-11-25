// Тесты генераторов csv-writer.js и xlsx-writer.js. Запуск: node --test
// Генераторы — обычные скрипты для браузера, поэтому загружаем их в глобальный контекст
// с window = globalThis (Blob и TextEncoder в Node есть).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { crc32 } from 'node:zlib';

globalThis.window = globalThis;
for (const f of ['csv-writer.js', 'xlsx-writer.js']) {
  runInThisContext(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), { filename: f });
}

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

// ---------- CSV ----------

const csvColumns = [{ title: 'Дата', type: 'date' }, { title: 'Текст' }, { title: 'Код', type: 'number' }];

test('csv: BOM, разделитель «;», CRLF', async () => {
  const blob = window.__primoCsv.build({ columns: csvColumns, rows: [['2026-11-05T13:25:26.121223', 'abc', 4]] });
  assert.equal(blob.type, 'text/csv;charset=utf-8');
  const b = await bytes(blob);
  assert.deepEqual([...b.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(b.slice(3));
  assert.equal(text, 'Дата;Текст;Код\r\n05.11.2026 13:25:26.121;abc;4\r\n');
});

test('csv: кавычки для ; " CR LF, удвоение кавычек, пустые значения', async () => {
  const rows = [[null, 'a;b', undefined], ['', 'say "hi"', ''], ['', 'line1\nline2', ''], ['', 'x\ry', '']];
  const text = new TextDecoder().decode((await bytes(window.__primoCsv.build({ columns: csvColumns, rows }))).slice(3));
  const lines = text.split('\r\n');
  assert.equal(lines[1], ';"a;b";');
  assert.equal(lines[2], ';"say ""hi""";');
  assert.equal(lines[3], ';"line1\nline2";');
  assert.equal(lines[4], ';"x\ry";');
});

test('csv: дата без миллисекунд и нераспознанная дата', async () => {
  const rows = [['2026-01-02 03:04:05', '', ''], ['не дата', '', '']];
  const text = new TextDecoder().decode((await bytes(window.__primoCsv.build({ columns: csvColumns, rows }))).slice(3));
  const lines = text.split('\r\n');
  assert.equal(lines[1], '02.01.2026 03:04:05.000;;');
  assert.equal(lines[2], 'не дата;;');
});

// ---------- XLSX ----------

// Разбор ZIP (метод STORE) по центральному каталогу: { имя → текст }
function unzip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const eocd = b.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'нет конца центрального каталога');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    assert.equal(dv.getUint16(p + 10, true), 0, 'ожидается метод STORE');
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(b.slice(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = b.slice(start, start + size);
    assert.equal(crc32(data), crc, `CRC32 не совпадает: ${name}`);
    files[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return files;
}

const xlsxColumns = [
  { title: 'Дата', width: 24, type: 'date' },
  { title: 'Текст', width: 70 },
  { title: 'Код', width: 12, type: 'number' },
];

test('xlsx: валидный ZIP со всеми частями пакета', async () => {
  const blob = window.__primoXlsx.build({ sheetName: 'Логи', columns: xlsxColumns, rows: [['2026-11-05T13:25:26.121', 'a', 1]] });
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const files = unzip(await bytes(blob));
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);
  assert.match(files['xl/workbook.xml'], /<sheet name="Логи"/);
  assert.match(files['xl/workbook.xml'], /'Логи'!\$A\$1:\$C\$2/);
});

test('xlsx: даты, числа, строки, автофильтр и закреплённый заголовок', async () => {
  const rows = [
    ['2026-11-05T13:25:26.121223', 'текст', 42],
    ['не дата', null, '7'],
  ];
  const sheet = unzip(await bytes(window.__primoXlsx.build({ columns: xlsxColumns, rows })))['xl/worksheets/sheet1.xml'];
  // 2026-11-05 13:25:26.121 → 46331 + (13*3600 + 25*60 + 26.121) / 86400
  const serial = Number(/<c r="A2" s="2"><v>([\d.]+)<\/v>/.exec(sheet)[1]);
  assert.ok(Math.abs(serial - (46331 + (13 * 3600 + 25 * 60 + 26.121) / 86400)) < 1e-9);
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">текст<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="C2"><v>42<\/v><\/c>/);
  // нераспознанная дата и число-строка пишутся текстом, null — пустой ячейкой
  assert.match(sheet, /<c r="A3" t="inlineStr"><is><t xml:space="preserve">не дата<\/t>/);
  assert.doesNotMatch(sheet, /r="B3"/);
  assert.match(sheet, /<c r="C3" t="inlineStr">/);
  assert.match(sheet, /<autoFilter ref="A1:C3"\/>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
});

test('xlsx: экранирование XML, недопустимые символы, лимит 32 767', async () => {
  const long = 'x'.repeat(40000);
  const rows = [['', '<a & "b">\u0001\u0008￾￿', ''], ['', long, '']];
  const sheet = unzip(await bytes(window.__primoXlsx.build({ columns: xlsxColumns, rows })))['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<t xml:space="preserve">&lt;a &amp; &quot;b&quot;&gt;<\/t>/);
  const cell = /<c r="B3"[^>]*><is><t[^>]*>([^<]*)<\/t>/.exec(sheet)[1];
  assert.equal(cell.length, 32761);
  assert.ok(cell.endsWith('x…'));
});

test('xlsx: имена колонок после Z и безопасное имя листа', async () => {
  const columns = Array.from({ length: 28 }, (_, i) => ({ title: 'c' + i }));
  const files = unzip(await bytes(window.__primoXlsx.build({ sheetName: 'a/b:c*d?[e]', columns, rows: [] })));
  assert.match(files['xl/worksheets/sheet1.xml'], /r="Z1".*r="AA1".*r="AB1"/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<autoFilter ref="A1:AB1"\/>/);
  assert.match(files['xl/workbook.xml'], /<sheet name="a b c d  e "/);
});
