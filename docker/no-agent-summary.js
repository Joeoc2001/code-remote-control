const SUMMARY_TIMER_ANCHOR = "[AgentSummary] Timer fired";
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const INSTALLED = Symbol.for("crc.no-agent-summary");

function isClaudeCode() {
  return typeof Bun !== "undefined" && Bun.main === "/$bunfs/root/cli";
}

function install() {
  const realSetTimeout = globalThis.setTimeout;
  const isSummaryTimer = new WeakMap();

  function matches(callback) {
    if (!isSummaryTimer.has(callback)) {
      isSummaryTimer.set(callback, Function.prototype.toString.call(callback).includes(SUMMARY_TIMER_ANCHOR));
    }
    return isSummaryTimer.get(callback);
  }

  function setTimeout(callback, ...rest) {
    if (typeof callback === "function" && matches(callback)) {
      const inert = realSetTimeout(() => {}, MAX_TIMER_DELAY_MS);
      inert.unref();
      return inert;
    }
    return realSetTimeout.call(this, callback, ...rest);
  }

  for (const key of Reflect.ownKeys(realSetTimeout)) {
    if (!Object.prototype.hasOwnProperty.call(setTimeout, key)) {
      Object.defineProperty(setTimeout, key, Object.getOwnPropertyDescriptor(realSetTimeout, key));
    }
  }

  globalThis.setTimeout = setTimeout;
  globalThis[INSTALLED] = true;
}

if (isClaudeCode() && !globalThis[INSTALLED]) {
  install();
}
