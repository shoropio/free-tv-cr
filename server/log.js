const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, args) {
  if (LEVELS[level] > configured) return;
  const tag = level.toUpperCase().padEnd(5);
  const prefix = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${stamp()} ${prefix}`, ...args);
}

export const log = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};
