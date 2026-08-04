// 统一 IP 格式，避免 ::ffff:x.x.x.x / ::1 等同机不同写法导致禁言失效
'use strict';

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  let s = String(ip).trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') s = '127.0.0.1';
  return s || 'unknown';
}

module.exports = { normalizeIp };
