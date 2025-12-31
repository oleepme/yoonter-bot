const timers = new Map();

function clearTimer(messageId) {
  const t = timers.get(messageId);
  if (t) clearTimeout(t);
  timers.delete(messageId);
}

function setTimer(messageId, timeoutId) {
  clearTimer(messageId);
  timers.set(messageId, timeoutId);
}

module.exports = { clearTimer, setTimer };
