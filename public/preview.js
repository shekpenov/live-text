// Сборка страницы из трёх вкладок (HTML, CSS, JS). Общий модуль для ученика и учителя.
// Работает в двух вариантах:
//   1) в HTML можно писать только содержимое страницы (без <html> и <body>) — обёртка добавится сама;
//   2) можно написать полный документ (<!doctype>, <html>, <head>, <body>) — CSS и JS подставятся внутрь.
(function (root) {
  var SC = '<' + '/script>';

  // Перехватывает console.log/warn/error и ошибки страницы и отправляет их в родительское окно
  var HOOK_SRC =
    '(function(){var OFF=__OFF__;' +
    'function S(x){try{if(x instanceof Error)return x.stack||x.message;return typeof x==="object"?JSON.stringify(x):String(x)}catch(e){return String(x)}}' +
    'function P(t,m){try{parent.postMessage({lt:1,t:t,m:m},"*")}catch(e){}}' +
    '["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){P(k,Array.prototype.map.call(arguments,S).join(" "));try{o.apply(console,arguments)}catch(e){}}});' +
    'window.addEventListener("error",function(e){var l=e.lineno&&e.lineno>OFF?e.lineno-OFF:0;P("error",e.message+(l?" (строка "+l+")":""))});' +
    'window.addEventListener("unhandledrejection",function(e){P("error","Promise: "+((e.reason&&e.reason.message)||e.reason))});' +
    '})();';

  // ---------- защита от бесконечных циклов ----------
  // В каждый цикл for/while/do { ... } добавляется вызов __ltl(): если цикл идёт непрерывно
  // дольше ~1.5 с, он прерывается ошибкой, и страница ученика не зависает.
  var LOOP_SRC =
    'var __lt=0,__ls=0,__ll=0;function __ltl(){if(++__lt%500)return;var n=Date.now();if(n-__ll>300)__ls=n;__ll=n;' +
    'if(n-__ls>1500){__lt=0;__ls=n;throw new Error("Цикл выполняется слишком долго (возможно, бесконечный). Выполнение остановлено")}}';

  function isId(c) { return /[A-Za-z0-9_$]/.test(c); }

  function skipStr(code, i) {
    var q = code[i], j = i + 1, n = code.length;
    while (j < n && code[j] !== q) { if (code[j] === '\\') j++; j++; }
    return Math.min(j + 1, n);
  }

  function guardLoops(code) {
    var out = '', i = 0, n = code.length, ch, e;
    while (i < n) {
      ch = code[i];
      if (ch === '/' && code[i + 1] === '/') { e = code.indexOf('\n', i); if (e < 0) e = n; out += code.slice(i, e); i = e; continue; }
      if (ch === '/' && code[i + 1] === '*') { e = code.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; out += code.slice(i, e); i = e; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { e = skipStr(code, i); out += code.slice(i, e); i = e; continue; }
      if (isId(ch) && (i === 0 || (!isId(code[i - 1]) && code[i - 1] !== '.'))) {
        var j = i;
        while (j < n && isId(code[j])) j++;
        var w = code.slice(i, j), k = j;
        while (k < n && /\s/.test(code[k])) k++;
        if ((w === 'for' || w === 'while') && code[k] === '(') {
          var depth = 0, p = k;
          while (p < n) {
            var c = code[p];
            if (c === '"' || c === "'" || c === '`') { p = skipStr(code, p); continue; }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) break; }
            p++;
          }
          var q = p + 1;
          while (q < n && /\s/.test(code[q])) q++;
          if (p < n && code[q] === '{') { out += code.slice(i, q + 1) + '__ltl();'; i = q + 1; continue; }
        } else if (w === 'do' && code[k] === '{') {
          out += code.slice(i, k + 1) + '__ltl();'; i = k + 1; continue;
        }
        out += w; i = j; continue;
      }
      out += ch; i++;
    }
    return out;
  }

  // Ссылки на style.css / script.js убираем: их содержимое уже лежит во вкладках CSS и JS
  function stripLocal(html) {
    html = html.replace(/<link\b[^>]*\bhref\s*=\s*["']?(?![a-z]+:|\/\/|\/)[^"'\s>]+\.css["']?[^>]*>/gi, '');
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["']?(?![a-z]+:|\/\/|\/)[^"'\s>]+\.js["']?[^>]*>\s*<\/script\s*>/gi, '');
    return html;
  }

  function insertHeadStart(doc, s) {
    var m;
    if ((m = /<head\b[^>]*>/i.exec(doc))) return doc.slice(0, m.index + m[0].length) + s + doc.slice(m.index + m[0].length);
    if ((m = /<html\b[^>]*>/i.exec(doc))) return doc.slice(0, m.index + m[0].length) + '<head>' + s + '</head>' + doc.slice(m.index + m[0].length);
    if ((m = /<body\b/i.exec(doc))) return doc.slice(0, m.index) + s + doc.slice(m.index);
    if ((m = /<!doctype[^>]*>/i.exec(doc))) return doc.slice(0, m.index + m[0].length) + s + doc.slice(m.index + m[0].length);
    return s + doc;
  }

  function insertHeadEnd(doc, s) {
    var m;
    if ((m = /<\/head\s*>/i.exec(doc))) return doc.slice(0, m.index) + s + doc.slice(m.index);
    return insertHeadStart(doc, s);
  }

  function insertBodyEnd(doc, s) {
    var re, m, last;
    var tags = [/<\/body\s*>/gi, /<\/html\s*>/gi];
    for (var i = 0; i < tags.length; i++) {
      re = tags[i]; last = -1;
      while ((m = re.exec(doc))) last = m.index;
      if (last >= 0) return doc.slice(0, last) + s + '\n' + doc.slice(last);
    }
    return doc + '\n' + s;
  }

  // f = {html, css, js}; o = {scripts: выполнять ли JS, console: перехватывать ли console}
  function buildDoc(f, o) {
    o = o || {};
    f = f || {};
    var html = stripLocal(String(f.html || ''));
    var css = String(f.css || '');
    var js = o.scripts ? guardLoops(String(f.js || '')) : '';
    if (o.scripts) {
      // скрипты, написанные учеником прямо во вкладке HTML, тоже защищаем
      html = html.replace(/(<script\b(?![^>]*\bsrc\b)[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, function (m, a, b, c) { return a + guardLoops(b) + c; });
    }
    var hook = o.scripts ? '<script>' + LOOP_SRC + '\n' + (o.console ? HOOK_SRC : '') + SC : '';
    var style = css ? '<style>\n' + css.replace(/<\/style/gi, '<\\/style') + '\n</style>' : '';
    var script = js ? '<script>/*LT*/\n' + js.replace(/<\/script/gi, '<\\/script') + '\n' + SC : '';
    var full = /<\s*(!doctype|html|head|body)\b/i.test(html);
    var doc;

    if (!full) {
      doc =
        '<!doctype html>\n<html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        hook + style + '</head>\n<body>\n' + html + '\n' + script + '\n</body></html>';
    } else {
      doc = html;
      if (!/<!doctype/i.test(doc)) doc = '<!doctype html>\n' + doc;
      if (hook) doc = insertHeadStart(doc, hook);
      if (style) doc = insertHeadEnd(doc, style);
      if (script) doc = insertBodyEnd(doc, script);
    }

    // номер строки, с которой начинается код из вкладки JS (чтобы в ошибках писать строку вкладки)
    var off = 0;
    var idx = doc.indexOf('/*LT*/');
    if (idx >= 0) off = (doc.slice(0, idx).match(/\n/g) || []).length + 1;
    return doc.replace('__OFF__', String(off));
  }

  var api = { buildDoc: buildDoc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LTPreview = api;
})(typeof self !== 'undefined' ? self : this);
