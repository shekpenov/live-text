// Python (Pyodide) в отдельном потоке браузера.
// Отдельный поток нужен, чтобы зависшую программу можно было остановить кнопкой «Стоп»,
// а input() мог ждать ввода ученика, не подвешивая страницу.

const CFG = self.PYODIDE_CFG || {
  module: self.location.origin + '/vendor/pyodide/pyodide.mjs',
  index: self.location.origin + '/vendor/pyodide/',
};
const MAX_OUT = 200000; // максимум символов вывода за один запуск

let pyodide = null;
let ctrl = null; // Int32Array на общей памяти: [0] флаг «ввод готов», [1] длина ввода в байтах
let data = null; // Uint8Array на общей памяти: сами байты ввода

let outBuf = '';
let outErr = false;
let lastFlush = 0;
let total = 0;
let limitHit = false;
const decOut = new TextDecoder();
const decErr = new TextDecoder();
const decIn = new TextDecoder();

function flush() {
  if (outBuf) {
    postMessage({ type: 'out', text: outBuf, err: outErr });
    outBuf = '';
  }
  lastFlush = Date.now();
}

function emit(text, err) {
  if (limitHit) return; // после превышения лимита молча игнорируем вывод
  if (err !== outErr) {
    flush();
    outErr = err;
  }
  outBuf += text;
  total += text.length;
  if (total > MAX_OUT) {
    limitHit = true;
    outBuf += '\n[вывод слишком большой, программа остановлена]\n';
    flush();
    throw new Error('output limit');
  }
  if (outBuf.length > 4000 || Date.now() - lastFlush > 60) flush();
}

// input(): ждём, пока страница положит введённую строку в общую память
function jsInput(prompt) {
  flush();
  if (!ctrl) {
    throw new Error('input() не работает в этом браузере. Откройте сайт в свежем Chrome, Edge, Firefox или Safari.');
  }
  Atomics.store(ctrl, 0, 0);
  postMessage({ type: 'input_request', prompt: String(prompt || '') });
  while (Atomics.wait(ctrl, 0, 0, 1000) === 'timed-out') {
    /* ждём */
  }
  const len = Atomics.load(ctrl, 1);
  const bytes = data.slice(0, len);
  Atomics.store(ctrl, 0, 0);
  return decIn.decode(bytes);
}

const BOOT = `
import builtins, sys, jsbridge
def _input(prompt=''):
    sys.stdout.flush()
    return jsbridge.input(str(prompt))
_input.__name__ = 'input'
builtins.input = _input
`;

function cleanError(e) {
  const msg = String((e && e.message) || e);
  const lines = msg.split('\n');
  const last = lines.filter((l) => l.trim()).pop() || '';
  if (last.startsWith('SystemExit')) return null; // exit() / sys.exit() — не ошибка
  if (last.includes('output limit')) return null;
  const i = lines.findIndex((l) => l.includes('File "<exec>"'));
  if (i >= 0) return 'Traceback (most recent call last):\n' + lines.slice(i).join('\n').trimEnd();
  return msg.trimEnd();
}

async function run(code) {
  total = 0;
  limitHit = false;
  outBuf = '';
  outErr = false;
  lastFlush = Date.now();
  let error = null;
  try {
    try {
      await pyodide.loadPackagesFromImports(code);
    } catch (e) {
      /* пакет недоступен — обычная ошибка импорта появится при запуске */
    }
    const g = pyodide.globals.get('dict')();
    g.set('__name__', '__main__');
    try {
      pyodide.runPython(code, { globals: g });
    } finally {
      g.destroy();
    }
  } catch (e) {
    error = limitHit ? null : cleanError(e); // при превышении лимита вывода текст уже показан
  }
  try {
    // limitHit не сбрасываем: остатки буфера после лимита просто выбрасываются
    pyodide.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()');
  } catch (e) {
    /* игнорируем */
  }
  flush();
  postMessage({ type: 'done', error });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    if (m.sab) {
      ctrl = new Int32Array(m.sab, 0, 2);
      data = new Uint8Array(m.sab, 8);
    }
    try {
      const { loadPyodide } = await import(CFG.module);
      pyodide = await loadPyodide({ indexURL: CFG.index });
      pyodide.setStdout({
        write: (buf) => {
          emit(decOut.decode(buf, { stream: true }), false);
          return buf.length;
        },
        isatty: true,
      });
      pyodide.setStderr({
        write: (buf) => {
          emit(decErr.decode(buf, { stream: true }), true);
          return buf.length;
        },
        isatty: true,
      });
      pyodide.registerJsModule('jsbridge', { input: jsInput });
      pyodide.runPython(BOOT);
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'init_error', error: String((err && err.message) || err) });
    }
  } else if (m.type === 'run') {
    await run(m.code);
  }
};
