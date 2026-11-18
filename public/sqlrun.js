// Общий модуль режима SQL для ученика и учителя: база SQLite в воркере, таблицы комнаты,
// запуск запросов с тайм-аутом, вывод результата (HTML и обычный текст), импорт CSV.
(function (root) {
  var TIMEOUT_MS = 8000;

  function create() {
    var worker = null, queue = Promise.resolve();
    var applied = [];            // id скриптов, уже выполненных в базе
    var parts = [];              // актуальный список таблиц комнаты
    var inst = { schema: [], errors: [], onSchema: null, onError: null };

    function spawn() {
      if (worker) { try { worker.terminate(); } catch (e) { /* уже остановлен */ } }
      worker = new Worker('/sql-worker.js');
      return worker;
    }
    function call(msg, ms) {
      return new Promise(function (resolve) {
        if (!worker) spawn();
        var w = worker, done = false;
        var timer = ms ? setTimeout(function () {
          if (done) return; done = true;
          spawn();           // зависший запрос: убиваем воркер, ниже базу соберём заново
          resolve({ type: 'timeout' });
        }, ms) : null;
        w.onmessage = function (e) {
          if (done) return; done = true; if (timer) clearTimeout(timer);
          resolve(e.data);
        };
        w.onerror = function (e) {
          if (done) return; done = true; if (timer) clearTimeout(timer);
          resolve({ type: 'fatal', error: (e && e.message) || 'Не удалось запустить SQLite' });
        };
        w.postMessage(msg);
      });
    }
    function apply(r) {
      if (r && r.schema) { inst.schema = r.schema; if (inst.onSchema) inst.onSchema(r.schema); }
      if (r && r.errors) { inst.errors = r.errors; if (inst.onError) inst.onError(r.errors); }
    }
    function rebuild() {
      return call({ type: 'init', parts: parts }, 20000).then(function (r) {
        if (r.type === 'ready') { applied = parts.map(function (p) { return p.id; }); apply(r); }
        else if (r.type === 'timeout') { applied = []; }
        return r;
      });
    }

    // Привести базу к списку таблиц комнаты: если только добавились — досоздаём, иначе собираем заново
    inst.sync = function (list) {
      list = list || [];
      queue = queue.then(function () {
        var ids = list.map(function (p) { return p.id; });
        var onlyAdded = applied.length > 0 && applied.every(function (id) { return ids.indexOf(id) >= 0; });
        parts = list;
        if (!onlyAdded) return rebuild();
        var fresh = list.filter(function (p) { return applied.indexOf(p.id) < 0; });
        if (!fresh.length) return null;
        return call({ type: 'add', parts: fresh }, 20000).then(function (r) {
          if (r.type === 'ready') { applied = applied.concat(fresh.map(function (p) { return p.id; })); apply(r); }
          return r;
        });
      });
      return queue;
    };
    inst.reset = function () { queue = queue.then(rebuild); return queue; };
    inst.exec = function (sql) {
      var p = queue.then(function () {
        return call({ type: 'exec', sql: sql }, TIMEOUT_MS).then(function (r) {
          if (r.type === 'result') { apply(r); return r; }
          if (r.type === 'timeout') {
            return rebuild().then(function () {
              return { sets: [], error: 'Запрос выполняется слишком долго (больше ' + (TIMEOUT_MS / 1000) + ' с) и остановлен. База возвращена к исходным таблицам.', errorAt: 0, ms: TIMEOUT_MS };
            });
          }
          return { sets: [], error: r.error || 'Ошибка SQLite', errorAt: 0, ms: 0 };
        });
      });
      queue = p.then(function () { }, function () { });
      return p;
    };
    inst.stop = function () { if (worker) { try { worker.terminate(); } catch (e) { /* уже остановлен */ } worker = null; } };
    return inst;
  }

  // ---------- вывод результата ----------
  function plural(n, a, b, c) { var m = n % 100, d = n % 10; return (m > 10 && m < 15) ? c : d === 1 ? a : (d > 1 && d < 5) ? b : c; }
  function rowsWord(n) { return n + ' ' + plural(n, 'строка', 'строки', 'строк'); }

  function toText(res) {
    var out = [];
    (res.sets || []).forEach(function (s, i) {
      if (s.kind === 'rows') {
        var cols = s.columns.map(String);
        var data = s.rows.slice(0, 60).map(function (r) { return r.map(function (v) { var t = v === null ? 'NULL' : String(v); return t.length > 28 ? t.slice(0, 27) + '…' : t; }); });
        var w = cols.map(function (c, j) { return Math.min(28, data.reduce(function (m, r) { return Math.max(m, r[j].length); }, c.length)); });
        var pad = function (t, n) { t = t.length > n ? t.slice(0, n - 1) + '…' : t; return t + ' '.repeat(Math.max(0, n - t.length)); };
        var lines = [cols.map(function (c, j) { return pad(c, w[j]); }).join(' | '), w.map(function (n) { return '-'.repeat(n); }).join('-+-')];
        data.forEach(function (r) { lines.push(r.map(function (c, j) { return pad(c, w[j]); }).join(' | ')); });
        lines.push('(' + rowsWord(s.total) + (s.total > data.length ? ', показаны первые ' + data.length : '') + ')');
        out.push(lines.join('\n'));
      } else {
        out.push('OK, изменено строк: ' + s.changes);
      }
    });
    if (res.error) out.push('Ошибка' + (res.errorAt ? ' в запросе №' + res.errorAt : '') + ': ' + res.error);
    if (!out.length) out.push('(пустой запрос)');
    return out.join('\n\n');
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function render(box, res) {
    box.textContent = '';
    (res.sets || []).forEach(function (s) {
      if (s.kind === 'rows') {
        var wrap = el('div', 'rt-wrap'), t = el('table', 'rt'), th = el('thead'), tr = el('tr');
        s.columns.forEach(function (c) { tr.appendChild(el('th', '', c)); });
        th.appendChild(tr); t.appendChild(th);
        var tb = el('tbody');
        s.rows.forEach(function (r) {
          var row = el('tr');
          r.forEach(function (v) {
            var td = v === null ? el('td', 'nul', 'NULL') : el('td', typeof v === 'number' ? 'num' : '', String(v));
            row.appendChild(td);
          });
          tb.appendChild(row);
        });
        t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
        box.appendChild(el('div', 'rt-note', rowsWord(s.total) + (s.truncated ? ', показаны первые ' + s.rows.length : '')));
      } else {
        box.appendChild(el('div', 'rt-ok', 'Выполнено, изменено строк: ' + s.changes));
      }
    });
    if (res.error) box.appendChild(el('div', 'rt-err', 'Ошибка' + (res.errorAt ? ' в запросе №' + res.errorAt : '') + ': ' + res.error));
    if (!box.children.length) box.appendChild(el('div', 'rt-note', 'Пустой запрос'));
    if (res.ms !== undefined && !res.error) box.appendChild(el('div', 'rt-note', res.ms + ' мс'));
  }

  // ---------- CSV → SQL ----------
  function parseCsv(text, delim) {
    var rows = [], row = [], cur = '', q = false, i = 0, n = text.length, c;
    text = text.replace(/^﻿/, '');
    n = text.length;
    while (i < n) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
        cur += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === delim) { row.push(cur); cur = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += c; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
  }
  function detectDelim(text) {
    var head = text.split('\n').slice(0, 5).join('\n'), best = ',', bestN = -1;
    [',', ';', '\t', '|'].forEach(function (d) { var n = head.split(d).length; if (n > bestN) { bestN = n; best = d; } });
    return best;
  }
  var qi = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
  var isInt = function (v) { return /^[-+]?\d{1,15}$/.test(v); };
  var isNum = function (v) { return /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(v); };

  // text — содержимое CSV; opts: {name, delim, header}. Возвращает {script, columns:[{name,type}], rows:[[...]], total}
  function csvToSql(text, opts) {
    opts = opts || {};
    var delim = opts.delim || detectDelim(text);
    var all = parseCsv(text, delim);
    if (!all.length) return { error: 'Файл пустой' };
    var header = opts.header !== false;
    var width = all.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var names = header ? all[0].slice() : [];
    var body = header ? all.slice(1) : all;
    var used = {};
    var cols = [];
    for (var j = 0; j < width; j++) {
      var nm = String((names[j] || '')).trim() || ('col' + (j + 1));
      var base = nm, k = 2; while (used[nm.toLowerCase()]) nm = base + '_' + (k++);
      used[nm.toLowerCase()] = 1;
      var type = 'INTEGER', seen = false;
      for (var r = 0; r < body.length; r++) {
        var v = (body[r][j] || '').trim(); if (v === '') continue; seen = true;
        if (type === 'INTEGER' && !isInt(v)) type = isNum(v) ? 'REAL' : 'TEXT';
        else if (type === 'REAL' && !isNum(v)) type = 'TEXT';
        if (type === 'TEXT') break;
      }
      cols.push({ name: nm, type: seen ? type : 'TEXT' });
    }
    var tname = String(opts.name || 'table1').trim() || 'table1';
    var lit = function (v, t) {
      v = (v === undefined ? '' : v).trim();
      if (v === '') return 'NULL';
      if (t === 'INTEGER') return v.replace(/^\+/, '');
      if (t === 'REAL') return v.replace(',', '.').replace(/^\+/, '');
      return "'" + v.replace(/'/g, "''") + "'";
    };
    var sql = 'DROP TABLE IF EXISTS ' + qi(tname) + ';\nCREATE TABLE ' + qi(tname) + ' (\n  ' + cols.map(function (c) { return qi(c.name) + ' ' + c.type; }).join(',\n  ') + '\n);\n';
    for (var s = 0; s < body.length; s += 200) {
      sql += 'INSERT INTO ' + qi(tname) + ' VALUES\n' + body.slice(s, s + 200).map(function (r) {
        return '(' + cols.map(function (c, j2) { return lit(r[j2], c.type); }).join(', ') + ')';
      }).join(',\n') + ';\n';
    }
    return { script: sql, columns: cols, rows: body.slice(0, 8), total: body.length, delim: delim };
  }

  root.LTSql = { create: create, toText: toText, render: render, csvToSql: csvToSql, rowsWord: rowsWord };
})(window);
