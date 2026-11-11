// Общие помощники интерфейса: тема, иконки, реакции, перестановка/скрытие окон
(function () {
  var KEY = 'lt_theme';
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() {
    var v = stored();
    if (v === 'dark' || v === 'light') return v;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply() { document.documentElement.setAttribute('data-theme', current()); }
  apply();

  var LT = window.LT = {};
  LT.theme = current;
  LT.toggleTheme = function () {
    try { localStorage.setItem(KEY, current() === 'dark' ? 'light' : 'dark'); } catch (e) { /* без хранилища */ }
    apply();
    window.dispatchEvent(new Event('lt-theme'));
  };
  // <svg> с иконкой из /icons.svg
  LT.ic = function (n) { return '<svg class="ic" aria-hidden="true"><use href="/icons.svg#i-' + n + '"/></svg>'; };
  // кнопка: иконка + подпись (подпись — обычный текст)
  LT.btn = function (el, icon, label) {
    el.innerHTML = (icon ? LT.ic(icon) : '') + (label ? '<span>' + String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' : '');
  };
  // заменяет <i data-i="name"></i> в разметке на иконки
  LT.hydrate = function (root) {
    (root || document).querySelectorAll('i[data-i]').forEach(function (i) {
      i.outerHTML = LT.ic(i.getAttribute('data-i'));
    });
  };

  // ---------- звук окончания таймера (три коротких сигнала) ----------
  var _ac = null;
  function actx() { try { var A = window.AudioContext || window.webkitAudioContext; if (!A) return null; if (!_ac) _ac = new A(); if (_ac.state === 'suspended') _ac.resume(); return _ac; } catch (e) { return null; } }
  ['pointerdown', 'keydown'].forEach(function (ev) { window.addEventListener(ev, function () { actx(); }, { once: true, capture: true }); });
  LT.chime = function () {
    var c = actx(); if (!c) return;
    [0, 0.28, 0.56].forEach(function (d, i) {
      var o = c.createOscillator(), g = c.createGain(), t = c.currentTime + d;
      o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.26);
    });
  };

  // ---------- реакции: всплывают снизу слева ----------
  LT.reaction = function (emoji, name, rid) {
    if (rid) { LT._rx = LT._rx || {}; if (LT._rx[rid]) return; LT._rx[rid] = 1; }
    var layer = document.getElementById('rxLayer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'rxLayer'; document.body.appendChild(layer); }
    var b = document.createElement('div');
    b.className = 'rx';
    b.style.left = (Math.random() * 40) + 'px';
    var e = document.createElement('span'); e.className = 'rx-e'; e.textContent = emoji;
    var n = document.createElement('span'); n.className = 'rx-n'; n.textContent = name || '';
    b.append(e, n);
    layer.appendChild(b);
    while (layer.children.length > 12) layer.removeChild(layer.firstChild);
    setTimeout(function () { b.remove(); }, 5200);
  };

  // ---------- окна: перетаскивание, стрелки, скрытие ----------
  // LT.panes(container, {key, panes:[{id, el, title, slot}], template(visibleIds)->строка колонок, restore: элемент})
  LT.panes = function (container, o) {
    var LS = 'lt_lay_' + o.key;
    var st = { order: o.panes.map(function (p) { return p.id; }), hidden: [] };
    try {
      var s = JSON.parse(localStorage.getItem(LS) || 'null');
      if (s && Array.isArray(s.order)) {
        var known = o.panes.map(function (p) { return p.id; });
        var ord = s.order.filter(function (id) { return known.indexOf(id) >= 0; });
        known.forEach(function (id) { if (ord.indexOf(id) < 0) ord.push(id); });
        st.order = ord; st.hidden = (s.hidden || []).filter(function (id) { return known.indexOf(id) >= 0; });
      }
    } catch (e) { /* без хранилища */ }
    var byId = {};
    o.panes.forEach(function (p) { byId[p.id] = p; });
    var mq = window.matchMedia('(min-width: 801px)');

    function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* без хранилища */ } }
    function move(id, dir) {
      var vis = st.order.filter(function (x) { return st.hidden.indexOf(x) < 0; });
      var i = vis.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= vis.length) return;
      var a = st.order.indexOf(vis[i]), b = st.order.indexOf(vis[j]);
      var t = st.order[a]; st.order[a] = st.order[b]; st.order[b] = t;
      render(); save();
    }
    function dropOn(dragId, targetId) {
      if (dragId === targetId) return;
      var a = st.order.indexOf(dragId), b = st.order.indexOf(targetId);
      if (a < 0 || b < 0) return;
      st.order.splice(a, 1); st.order.splice(b, 0, dragId);
      render(); save();
    }
    function setHidden(id, h) {
      var i = st.hidden.indexOf(id);
      if (h && i < 0) {
        if (o.panes.length - st.hidden.length <= 1) return; // хотя бы одно окно остаётся
        st.hidden.push(id);
      }
      if (!h && i >= 0) st.hidden.splice(i, 1);
      render(); save();
    }
    function render() {
      st.order.forEach(function (id, idx) {
        var p = byId[id];
        p.el.style.order = idx;
        p.el.classList.toggle('pane-hidden', st.hidden.indexOf(id) >= 0);
      });
      var vis = st.order.filter(function (x) { return st.hidden.indexOf(x) < 0; });
      container.style.setProperty('--pn', vis.length);
      container.style.gridTemplateColumns = (o.template && mq.matches) ? o.template(vis) : '';
      if (o.restore) {
        o.restore.textContent = '';
        st.hidden.forEach(function (id) {
          var b = document.createElement('button');
          b.className = 'pane-restore';
          b.innerHTML = LT.ic('eye') + '<span>' + byId[id].title + '</span>';
          b.title = 'Показать окно';
          b.onclick = function () { setHidden(id, false); };
          o.restore.appendChild(b);
        });
        o.restore.classList.toggle('hidden', !st.hidden.length);
      }
      o.panes.forEach(function (p) {
        var first = vis[0] === p.id, last = vis[vis.length - 1] === p.id;
        if (p._l) p._l.disabled = first || vis.length < 2;
        if (p._r) p._r.disabled = last || vis.length < 2;
        if (p._h) p._h.disabled = vis.length < 2;
      });
      if (o.onChange) o.onChange(vis);
    }
    o.panes.forEach(function (p) {
      var c = document.createElement('span'); c.className = 'pc';
      var g = document.createElement('span'); g.className = 'pc-grip'; g.title = 'Перетащить окно'; g.draggable = true; g.innerHTML = LT.ic('grip');
      var l = document.createElement('button'); l.className = 'pc-b'; l.title = 'Сдвинуть влево / вверх'; l.innerHTML = LT.ic('left');
      var r = document.createElement('button'); r.className = 'pc-b'; r.title = 'Сдвинуть вправо / вниз'; r.innerHTML = LT.ic('right');
      var h = document.createElement('button'); h.className = 'pc-b'; h.title = 'Скрыть окно'; h.innerHTML = LT.ic('eye-off');
      l.onclick = function () { move(p.id, -1); }; r.onclick = function () { move(p.id, 1); }; h.onclick = function () { setHidden(p.id, true); };
      g.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'lt-pane:' + p.id); e.dataTransfer.effectAllowed = 'move'; p.el.classList.add('pane-drag'); });
      g.addEventListener('dragend', function () { o.panes.forEach(function (q) { q.el.classList.remove('pane-drag', 'pane-over'); }); });
      p.el.addEventListener('dragover', function (e) { if ((e.dataTransfer.types || []).indexOf('text/plain') >= 0) { e.preventDefault(); p.el.classList.add('pane-over'); } });
      p.el.addEventListener('dragleave', function () { p.el.classList.remove('pane-over'); });
      p.el.addEventListener('drop', function (e) {
        var t = e.dataTransfer.getData('text/plain'); p.el.classList.remove('pane-over');
        if (t.indexOf('lt-pane:') === 0 && byId[t.slice(8)]) { e.preventDefault(); dropOn(t.slice(8), p.id); }
      });
      c.append(g, l, r, h);
      p._l = l; p._r = r; p._h = h;
      (p.slot || p.el).appendChild(c);
    });
    if (mq.addEventListener) mq.addEventListener('change', render);
    render();
    return { render: render, show: function (id) { setHidden(id, false); } };
  };
})();
