/**
 * 结构化日志：JSON 一行一条，等级可配（默认 info），错误/告警走 stderr。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, msg, extra = {}) {
  if (LEVELS[level] < LEVELS[LEVEL]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg, extra) => log('debug', msg, extra),
  info: (msg, extra) => log('info', msg, extra),
  warn: (msg, extra) => log('warn', msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};