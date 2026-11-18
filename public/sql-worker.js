// SQLite (sql.js) в отдельном потоке: так зависший запрос можно остановить, не трогая страницу.
// Сообщения:
//   {type:'init', parts:[{id,script}]}  — собрать новую базу из скриптов таблиц
//   {type:'add',  parts:[...]}          — досоздать таблицы в текущей базе
//   {type:'exec', sql}                  — выполнить запрос(ы)
importScripts('/vendor/sqljs/sql-wasm.js');

const MAX_ROWS = 500;
let SQL = null, db = null;

const ready = initSqlJs({ locateFile: (f) => '/vendor/sqljs/' + f }).then((m) => { SQL = m; });

function cell(v) {
  if (v instanceof Uint8Array) return '[BLOB ' + v.length + ' байт]';
  return v;
}

function schema() {
  const out = [];
  if (!db) return out;
  const list = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  if (!list.length) return out;
  for (const [name, type] of list[0].values) {
    const q = '"' + String(name).replace(/"/g, '""') + '"';
    let cols = [], count = null;
    try {
      const ti = db.exec('PRAGMA table_info(' + q + ')');
      if (ti.length) cols = ti[0].values.map((r) => ({ name: r[1], type: r[2] || '', pk: !!r[5] }));
      const c = db.exec('SELECT COUNT(*) FROM ' + q);
      if (c.length) count = c[0].values[0][0];
    } catch (e) { /* представление может не считаться */ }
    out.push({ name, type, cols, count });
  }
  return out;
}

function runScript(sql) {
  db.run(sql);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.type === 'init') {
      if (db) db.close();
      db = new SQL.Database();
      const errors = [];
      for (const p of m.parts || []) {
        try { runScript(p.script); } catch (err) { errors.push({ id: p.id, name: p.name, error: String(err.message || err) }); }
      }
      self.postMessage({ type: 'ready', errors, schema: schema() });
    } else if (m.type === 'add') {
      if (!db) db = new SQL.Database();
      const errors = [];
      for (const p of m.parts || []) {
        try { runScript(p.script); } catch (err) { errors.push({ id: p.id, name: p.name, error: String(err.message || err) }); }
      }
      self.postMessage({ type: 'ready', errors, schema: schema() });
    } else if (m.type === 'exec') {
      if (!db) db = new SQL.Database();
      const t0 = Date.now();
      const sets = [];
      let error = null, errorAt = -1, n = 0, inBody = false;
      try {
        for (const st of db.iterateStatements(m.sql)) {
          n++; inBody = true;
          const cols = st.getColumnNames();
          if (cols.length) {
            const rows = []; let total = 0;
            while (st.step()) { total++; if (rows.length < MAX_ROWS) rows.push(st.get().map(cell)); }
            sets.push({ kind: 'rows', columns: cols, rows, total, truncated: total > rows.length, sql: st.getSQL ? st.getSQL() : '' });
          } else {
            st.step();
            sets.push({ kind: 'ok', changes: db.getRowsModified(), sql: st.getSQL ? st.getSQL() : '' });
          }
          inBody = false;
        }
      } catch (err) { error = String(err.message || err); errorAt = inBody ? n : n + 1; }
      self.postMessage({ type: 'result', sets, error, errorAt, ms: Date.now() - t0, schema: schema() });
    }
  } catch (err) {
    self.postMessage({ type: 'fatal', error: String(err && err.message || err) });
  }
};
