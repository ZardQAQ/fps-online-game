// 局内公屏发言落盘：追加写入 data/chatlog.jsonl（一行一条，便于检索）
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'chatlog.jsonl');

let ready = false;
let queue = [];
let flushTimer = null;

function ensureDir() {
  if (ready) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    ready = true;
  } catch (e) {
    console.error('[chatlog] 无法创建目录:', e.message);
  }
}

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  ensureDir();
  if (!ready) { queue = []; return; }
  const chunk = queue.join('');
  queue = [];
  fs.appendFile(FILE, chunk, err => {
    if (err) console.error('[chatlog] 写入失败:', err.message);
  });
}

/**
 * @param {{ name: string, text: string, ip?: string, color?: string }} entry
 */
function append(entry) {
  if (!entry || !entry.text) return;
  const d = new Date();
  const line = JSON.stringify({
    t: d.toISOString(),
    time: d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    name: String(entry.name || '').slice(0, 32),
    text: String(entry.text).slice(0, 200),
    ip: entry.ip && entry.ip !== 'unknown' ? String(entry.ip).slice(0, 64) : undefined,
  }) + '\n';
  queue.push(line);
  if (queue.length >= 20) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 800);
}

function saveNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flush();
}

module.exports = { append, saveNow };
