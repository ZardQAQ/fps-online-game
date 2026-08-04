// 公屏聊天辱骂检测（规范化后匹配关键词/拼音缩写）
'use strict';

const PHRASES = [
  '操你妈', '操你媽', '草你妈', '艹你妈', '操你娘', '草你娘', '艹你娘',
  '操你爸', '草你爸', '艹你爸', '操你爹', '草你爹', '艹你爹',
  '艹尼玛', '草尼玛', '操尼玛', '尼玛',
  '操你全家', '草你全家', '你妈死了', '你爸死了', '你爹死了', '去死吧你',
  'cnm', 'cnmb', 'cnmmd', 'cnmd', 'caonima', 'caonimabi', 'caonimade',
  'nmsl', 'nmlgb', 'nmldb', 'nimabi', 'nimadebi', 'nimab',
  '傻逼', '煞笔', '傻b', '沙比', 'shabi', 'sb东西', 's逼', '伞兵',
  '贱人', '婊子', '狗东西', '去你妈', '去你媽', '去你爸', '去你爹',
  'fuckyou', 'motherfucker',
];

const REGEXES = [
  /操.{0,2}[你尼].{0,2}[妈瑪爸爹]/,
  /草.{0,2}[你尼].{0,2}[妈瑪爸爹]/,
  /艹.{0,2}[你尼].{0,2}[妈瑪爸爹]/,
  /[你尼].{0,2}[妈瑪爸爹].{0,2}死/,
  /c\s*n\s*m/i,
  /n\s*m\s*s\s*l/i,
  /(^|[^a-z])s[\W_]*b([^a-z]|$)/i,  // sb / s b / s.b
  /s\s*逼/,
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[`~!@#$%^&*()_\-+=\[\]{}|\\;:'",.<>?/·、，。！？]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[@＠]/g, 'a')
    .replace(/0/g, 'o')
    .replace(/1|!|丨/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/[￥¥]/g, 'y');
}

function containsProfanity(text) {
  const raw = String(text || '');
  const n = normalize(raw);
  if (!n) return false;
  // 一刀切：出现 爸/爹/妈 即触发
  if (/[爸爹妈媽]/.test(raw) || /[爸爹妈媽]/.test(n)) return true;
  for (const p of PHRASES) {
    if (n.includes(p)) return true;
  }
  for (const re of REGEXES) {
    if (re.test(raw) || re.test(n)) return true;
  }
  return false;
}

module.exports = { containsProfanity, normalize };
