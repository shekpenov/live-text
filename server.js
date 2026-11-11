const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_TEXT = 20000;       // максимум символов в коде/ответе ученика
const MAX_OUT = 20000;        // максимум символов вывода программы
const MAX_NAME = 40;
const MAX_STUDENTS = 200;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // комната живёт 12 часов без активности
const MAX_FILE = 30000;       // максимум символов в одной вкладке HTML/CSS/JS
const MODES = ['text', 'python', 'html'];
const MAX_TASK = 4000;                 // максимум символов в тексте задания
const REACTIONS = ['👍', '👏', '❤️', '😂', '😮', '🤔', '🔥', '🎉'];
// Реакции: можно слать свободно, но не больше REACTION_BURST за REACTION_WINDOW_MS; при превышении — пауза REACTION_COOLDOWN_MS
const REACTION_BURST = 3;
const REACTION_WINDOW_MS = 10 * 1000;
const REACTION_COOLDOWN_MS = 15 * 1000;
const STATES = ['idle', 'running', 'input'];
const emptyFiles = () => ({ html: '', css: '', js: '' });

const app = express();
app.use(compression());

// Эти заголовки нужны, чтобы input() в Python работал как в терминале
// (включают SharedArrayBuffer в браузере ученика).
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/teacher', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: code -> { code, teacherKey, mode, locked, students: Map, teachers: Set<ws>, touched }
const rooms = new Map();
let rxSeq = 0;

function newCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function toTeachers(room, obj) {
  for (const t of room.teachers) send(t, obj);
}

function publicStudent(id, s) {
  return { id, name: s.name, text: s.text, files: s.files, output: s.output, state: s.state, online: s.online, ts: s.ts, hand: !!s.hand, handAt: s.handAt || 0 };
}

// Таймер комнаты — конечный автомат. state: idle (не запущен) → running ⇄ paused → finished (время вышло).
// duration > 0 — обратный отсчёт на столько миллисекунд, 0 — секундомер. acc — уже отработанное время.
const MAX_TIMER_MS = 600 * 60000;
function newTimer(duration) { return { state: 'idle', duration: duration || 0, base: duration || 0, acc: 0, startedAt: 0 }; }
function elapsedOf(room) {
  const t = room.timer;
  return t.acc + (t.state === 'running' ? Date.now() - t.startedAt : 0);
}
function timerMsg(room) {
  const t = room.timer;
  return { type: 'timer', state: t.state, running: t.state === 'running', elapsed: elapsedOf(room), limitMs: t.duration, expired: t.state === 'finished' };
}
function setLocked(room, v, byTimer) {
  room.locked = !!v;
  room.lockedByTimer = !!v && !!byTimer;
  toTeachers(room, { type: 'lock', locked: room.locked });
  for (const st of room.students.values()) if (st.ws) send(st.ws, { type: 'lock', locked: room.locked });
}
// Время вышло: таймер встаёт на нуле, ввод у учеников закрывается автоматически
function unlockIfTimer(room) { if (room.locked && room.lockedByTimer) setLocked(room, false); }
function checkTimers() {
  for (const room of rooms.values()) {
    const t = room.timer;
    if (t.state === 'running' && t.duration && elapsedOf(room) >= t.duration) {
      t.acc = t.duration; t.state = 'finished';
      pushTimer(room);
      if (!room.locked) setLocked(room, true, true);
    }
  }
}
setInterval(checkTimers, 500);

function pushTimer(room) {
  const m = timerMsg(room);
  toTeachers(room, m);
  for (const s of room.students.values()) if (s.ws) send(s.ws, m);
}

// Таблица лидеров: кто нажал «Я всё», по порядку; время — по таймеру (null, если таймер не запускали)
function boardOf(room) {
  return [...room.students]
    .filter(([, s]) => s.doneAt)
    .sort((a, b) => a[1].doneAt - b[1].doneAt)
    .map(([id, s]) => ({ id, name: s.name, ms: s.doneMs }));
}

function pushBoard(room) {
  const m = { type: 'board', board: boardOf(room) };
  toTeachers(room, m);
  for (const s of room.students.values()) if (s.ws) send(s.ws, m);
}

function teacherReady(room) {
  return {
    type: 'teacher_ready',
    code: room.code,
    key: room.teacherKey,
    mode: room.mode,
    locked: room.locked,
    students: [...room.students].map(([id, s]) => publicStudent(id, s)),
    board: boardOf(room),
    timer: timerMsg(room),
    task: room.task,
  };
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.room = null;
  ws.studentId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // ---------- Учитель ----------
    if (msg.type === 'teacher_create') {
      const room = {
        code: newCode(),
        teacherKey: crypto.randomBytes(12).toString('hex'),
        mode: 'text',
        locked: false,
        students: new Map(),
        teachers: new Set(),
        touched: Date.now(),
        timer: newTimer(0),
        task: { text: '', ts: 0 },
      };
      rooms.set(room.code, room);
      ws.role = 'teacher';
      ws.room = room;
      room.teachers.add(ws);
      send(ws, teacherReady(room));
      return;
    }

    if (msg.type === 'teacher_join') {
      const room = rooms.get(String(msg.code));
      if (!room || room.teacherKey !== msg.key) {
        send(ws, { type: 'error', reason: 'room_not_found' });
        return;
      }
      ws.role = 'teacher';
      ws.room = room;
      room.teachers.add(ws);
      room.touched = Date.now();
      send(ws, teacherReady(room));
      return;
    }

    if (ws.role === 'teacher' && ws.room) {
      const room = ws.room;
      room.touched = Date.now();
      if (msg.type === 'set_lock') {
        setLocked(room, !!msg.locked, false);
      } else if (msg.type === 'set_mode') {
        const mode = MODES.includes(msg.mode) ? msg.mode : 'text';
        room.mode = mode;
        toTeachers(room, { type: 'mode', mode });
        for (const s of room.students.values()) {
          if (s.ws) send(s.ws, { type: 'mode', mode });
        }
      } else if (msg.type === 'clear_all') {
        for (const [id, s] of room.students) {
          s.text = '';
          s.files = emptyFiles();
          s.output = '';
          s.state = 'idle';
          s.ts = Date.now();
          s.doneAt = 0;
          s.hand = false;
          if (s.ws) send(s.ws, { type: 'set_text', text: '', files: emptyFiles(), clearOutput: true });
          if (s.ws) send(s.ws, { type: 'hand', hand: false });
          toTeachers(room, { type: 'student', student: publicStudent(id, s) });
        }
        room.timer = newTimer(room.timer.base);
        unlockIfTimer(room);
        pushBoard(room);
        pushTimer(room);
      } else if (msg.type === 'task_set') {
        // новое задание: текст + (по желанию) новый раунд с таймером
        room.task = { text: String(msg.text || '').slice(0, MAX_TASK), ts: Date.now() };
        const m = { type: 'task', task: room.task };
        toTeachers(room, m);
        for (const st of room.students.values()) if (st.ws) send(st.ws, m);
        if (msg.start) {
          const limit = typeof msg.limitMin === 'number' && msg.limitMin > 0 && msg.limitMin <= 600 ? Math.round(msg.limitMin * 60000) : 0;
          room.timer = { state: 'running', duration: limit, base: limit, acc: 0, startedAt: Date.now() };
          unlockIfTimer(room);
          for (const st of room.students.values()) st.doneAt = 0;
          pushBoard(room);
          pushTimer(room);
        }
      } else if (msg.type === 'task_clear') {
        room.task = { text: '', ts: Date.now() };
        const m = { type: 'task', task: room.task };
        toTeachers(room, m);
        for (const st of room.students.values()) if (st.ws) send(st.ws, m);
      } else if (msg.type === 'timer_set') {
        // длительность задаётся только пока таймер не запущен; 0 — секундомер
        const t = room.timer;
        if (t.state === 'idle') {
          t.duration = t.base = Math.max(0, Math.min(MAX_TIMER_MS, Math.round(Number(msg.sec) || 0) * 1000));
          pushTimer(room);
        }
      } else if (msg.type === 'timer_start') {
        // старт из «не запущен», продолжение с паузы, или заново после «время вышло»
        const t = room.timer;
        if (t.state === 'idle' && typeof msg.sec === 'number') t.duration = t.base = Math.max(0, Math.min(MAX_TIMER_MS, Math.round(msg.sec) * 1000));
        if (t.state === 'finished') { t.acc = 0; unlockIfTimer(room); }
        if (t.state !== 'running') { t.state = 'running'; t.startedAt = Date.now(); }
        pushTimer(room);
      } else if (msg.type === 'timer_pause') {
        const t = room.timer;
        if (t.state === 'running') { t.acc = elapsedOf(room); t.state = 'paused'; }
        pushTimer(room);
      } else if (msg.type === 'timer_add') {
        // ±секунды к длительности. Если время уже вышло — отсчёт продолжается с добавленных секунд, ввод открывается
        const t = room.timer;
        const sec = Math.max(-3600, Math.min(3600, Math.round(Number(msg.sec) || 0)));
        if (t.state === 'idle') t.duration = t.base = Math.max(0, Math.min(MAX_TIMER_MS, t.duration + sec * 1000));
        else if (t.duration) {
          if (t.state === 'finished') {
            if (sec > 0) { t.duration += sec * 1000; t.state = 'running'; t.startedAt = Date.now(); unlockIfTimer(room); }
          } else t.duration = Math.max(1000, Math.min(MAX_TIMER_MS, t.duration + sec * 1000));
        }
        pushTimer(room);
      } else if (msg.type === 'timer_reset') {
        // в «не запущен», длительность сохраняется; таблица лидеров не трогается
        room.timer = newTimer(room.timer.base);
        unlockIfTimer(room);
        pushTimer(room);
      } else if (msg.type === 'lb_remove') {
        const s = room.students.get(msg.id);
        if (s) { s.doneAt = 0; pushBoard(room); }
      } else if (msg.type === 'lb_reset') {
        for (const s of room.students.values()) s.doneAt = 0;
        pushBoard(room);
      } else if (msg.type === 'hand_down') {
        const s = room.students.get(msg.id);
        if (s) {
          s.hand = false;
          if (s.ws) send(s.ws, { type: 'hand', hand: false });
          toTeachers(room, { type: 'student', student: publicStudent(msg.id, s) });
        }
      } else if (msg.type === 'teacher_edit') {
        // учитель правит код/текст ученика: сохраняем и отправляем ученику
        const s = room.students.get(msg.id);
        const field = msg.field;
        if (s && ['text', 'html', 'css', 'js'].includes(field) && typeof msg.value === 'string') {
          if (field === 'text') s.text = msg.value.slice(0, MAX_TEXT);
          else s.files = { ...s.files, [field]: msg.value.slice(0, MAX_FILE) };
          s.ts = Date.now();
          if (s.ws) send(s.ws, { type: 'teacher_edit', field, value: field === 'text' ? s.text : s.files[field] });
          toTeachers(room, { type: 'student', student: publicStudent(msg.id, s) });
        }
      } else if (msg.type === 'kick') {
        const s = room.students.get(msg.id);
        if (s) {
          if (s.ws) {
            send(s.ws, { type: 'kicked' });
            s.ws.close();
          }
          room.students.delete(msg.id);
          toTeachers(room, { type: 'student_removed', id: msg.id });
          pushBoard(room);
        }
      }
      return;
    }

    // ---------- Ученик ----------
    if (msg.type === 'student_join') {
      const room = rooms.get(String(msg.code));
      if (!room) {
        send(ws, { type: 'error', reason: 'room_not_found' });
        return;
      }
      const name = String(msg.name || '').trim().slice(0, MAX_NAME);
      if (!name) {
        send(ws, { type: 'error', reason: 'name_required' });
        return;
      }
      let id = typeof msg.id === 'string' && room.students.has(msg.id) ? msg.id : null;
      if (!id) {
        if (room.students.size >= MAX_STUDENTS) {
          send(ws, { type: 'error', reason: 'room_full' });
          return;
        }
        id = crypto.randomBytes(8).toString('hex');
        room.students.set(id, { name, text: '', files: emptyFiles(), output: '', state: 'idle', online: true, ts: Date.now(), ws: null, doneAt: 0, hand: false, handAt: 0 });
      }
      const s = room.students.get(id);
      if (s.ws && s.ws !== ws) s.ws.close();
      s.ws = ws;
      s.name = name;
      s.online = true;
      ws.role = 'student';
      ws.room = room;
      ws.studentId = id;
      room.touched = Date.now();
      send(ws, { type: 'student_ready', id, text: s.text, files: s.files, output: s.output, mode: room.mode, locked: room.locked, hand: !!s.hand, board: boardOf(room), timer: timerMsg(room), task: room.task });
      toTeachers(room, { type: 'student', student: publicStudent(id, s) });
      if (s.doneAt) pushBoard(room);
      return;
    }

    if (ws.role === 'student' && ws.room) {
      const room = ws.room;
      const s = room.students.get(ws.studentId);
      if (!s) return;

      if (msg.type === 'done') {
        const want = !!msg.done;
        if (want && !s.doneAt) {
          s.doneAt = Date.now();
          const el = elapsedOf(room);
          s.doneMs = (room.timer.state !== 'idle' || el > 0) ? el : null;
        }
        else if (!want) s.doneAt = 0;
        room.touched = Date.now();
        pushBoard(room);
        return;
      }
      if (msg.type === 'reaction') {
        const emoji = String(msg.emoji || '');
        if (!REACTIONS.includes(emoji)) return;
        const now = Date.now();
        const wait = (s.rxBlockUntil || 0) - now;
        if (wait > 0) { send(ws, { type: 'reaction_wait', ms: wait }); return; }
        s.rxTimes = (s.rxTimes || []).filter((t) => now - t < REACTION_WINDOW_MS);
        if (s.rxTimes.length >= REACTION_BURST) { // слишком часто — уходит в паузу, эта реакция не показывается
          s.rxBlockUntil = now + REACTION_COOLDOWN_MS; s.rxTimes = [];
          send(ws, { type: 'reaction_wait', ms: REACTION_COOLDOWN_MS });
          return;
        }
        s.rxTimes.push(now);
        const m = { type: 'reaction', emoji, name: s.name, rid: ++rxSeq };
        toTeachers(room, m);
        for (const st of room.students.values()) if (st.ws) send(st.ws, m);
        return;
      }
      if (msg.type === 'hand') {
        const want = !!msg.hand;
        if (want !== !!s.hand) { s.hand = want; s.handAt = want ? Date.now() : 0; }
        room.touched = Date.now();
        toTeachers(room, { type: 'student', student: publicStudent(ws.studentId, s) });
        return;
      }
      if (msg.type === 'text') {
        if (room.locked) return;
        s.text = String(msg.text || '').slice(0, MAX_TEXT);
      } else if (msg.type === 'files') {
        if (room.locked) return;
        const f = msg.files || {};
        s.files = {
          html: String(f.html || '').slice(0, MAX_FILE),
          css: String(f.css || '').slice(0, MAX_FILE),
          js: String(f.js || '').slice(0, MAX_FILE),
        };
      } else if (msg.type === 'output') {
        s.output = String(msg.output || '').slice(-MAX_OUT);
        s.state = STATES.includes(msg.state) ? msg.state : 'idle';
      } else {
        return;
      }
      s.ts = Date.now();
      room.touched = Date.now();
      toTeachers(room, { type: 'student', student: publicStudent(ws.studentId, s) });
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (ws.role === 'teacher') {
      room.teachers.delete(ws);
    } else if (ws.role === 'student') {
      const s = room.students.get(ws.studentId);
      if (s && s.ws === ws) {
        s.online = false;
        s.ws = null;
        toTeachers(room, { type: 'student', student: publicStudent(ws.studentId, s) });
      }
    }
  });
});

// Чистим старые комнаты
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_TTL_MS && room.teachers.size === 0) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Страница учителя: http://localhost:${PORT}/teacher`);
});
