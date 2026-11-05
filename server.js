const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_TEXT = 20000;       // максимум символов в ответе ученика
const MAX_NAME = 40;
const MAX_STUDENTS = 200;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // комната живёт 12 часов без активности

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/teacher', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: code -> { code, teacherKey, locked, students: Map, teachers: Set<ws>, touched }
const rooms = new Map();

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
  return { id, name: s.name, text: s.text, online: s.online, ts: s.ts };
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
        locked: false,
        students: new Map(),
        teachers: new Set(),
        touched: Date.now(),
      };
      rooms.set(room.code, room);
      ws.role = 'teacher';
      ws.room = room;
      room.teachers.add(ws);
      send(ws, {
        type: 'teacher_ready',
        code: room.code,
        key: room.teacherKey,
        locked: room.locked,
        students: [],
      });
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
      send(ws, {
        type: 'teacher_ready',
        code: room.code,
        key: room.teacherKey,
        locked: room.locked,
        students: [...room.students].map(([id, s]) => publicStudent(id, s)),
      });
      return;
    }

    if (ws.role === 'teacher' && ws.room) {
      const room = ws.room;
      room.touched = Date.now();
      if (msg.type === 'set_lock') {
        room.locked = !!msg.locked;
        toTeachers(room, { type: 'lock', locked: room.locked });
        for (const s of room.students.values()) {
          if (s.ws) send(s.ws, { type: 'lock', locked: room.locked });
        }
      } else if (msg.type === 'clear_all') {
        for (const [id, s] of room.students) {
          s.text = '';
          s.ts = Date.now();
          if (s.ws) send(s.ws, { type: 'set_text', text: '' });
          toTeachers(room, { type: 'student', student: publicStudent(id, s) });
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
        room.students.set(id, { name, text: '', online: true, ts: Date.now(), ws: null });
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
      send(ws, { type: 'student_ready', id, text: s.text, locked: room.locked });
      toTeachers(room, { type: 'student', student: publicStudent(id, s) });
      return;
    }

    if (ws.role === 'student' && ws.room && msg.type === 'text') {
      const room = ws.room;
      const s = room.students.get(ws.studentId);
      if (!s || room.locked) return;
      s.text = String(msg.text || '').slice(0, MAX_TEXT);
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
