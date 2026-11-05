'use strict';

/**
 * 定时整理。
 *
 * 用**单次 setTimeout 精确排到下一次触发时刻**，而不是每秒检查一次时间——
 * 后者就是轮询，会让"空闲 CPU 接近 0"这条要求直接失效。
 *
 * 每次触发后重新计算下一次；用户改了设置就重排，不会留下野定时器。
 */
function createScheduler({ getSettings, onFire, logger = console } = {}) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let nextAt = 0;
  let running = false;

  /**
   * 计算下一次触发时间。
   * @param {{freq:string,hour:number,minute:number,weekday:number}} schedule
   * @param {Date} from
   */
  function nextRunAt(schedule, from = new Date()) {
    const hour = schedule.hour ?? 9;
    const minute = schedule.minute ?? 0;
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setHours(hour, minute, 0, 0);

    if (schedule.freq === 'weekly') {
      const target = schedule.weekday ?? 1; // 1 = 周一 … 7 = 周日
      const current = candidate.getDay() === 0 ? 7 : candidate.getDay();
      let delta = target - current;
      if (delta < 0) delta += 7;
      candidate.setDate(candidate.getDate() + delta);
      // 本周同一天但今天这一时刻已经过了，顺延一周
      if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 7);
      return candidate;
    }

    // 每天：今天这个点还没到就用今天，否则用明天
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextAt = 0;
  }

  /** 按当前设置重排定时器 */
  function arm() {
    clear();
    const settings = typeof getSettings === 'function' ? getSettings() : null;
    const schedule = settings?.schedule;
    if (!schedule?.enabled) return null;

    const next = nextRunAt(schedule);
    nextAt = next.getTime();
    const delay = Math.max(1000, nextAt - Date.now());
    timer = setTimeout(fire, delay);
    // 定时器不该阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
    return next.getTime();
  }

  async function fire() {
    timer = null;
    nextAt = 0;
    if (running) {
      arm();
      return;
    }
    running = true;
    try {
      if (typeof onFire === 'function') await onFire();
    } catch (err) {
      logger.warn?.('[scheduler] 定时任务执行失败：', err.message);
    } finally {
      running = false;
      arm();
    }
  }

  function status() {
    const settings = typeof getSettings === 'function' ? getSettings() : null;
    const schedule = settings?.schedule || {};
    return {
      enabled: Boolean(schedule.enabled),
      freq: schedule.freq || 'daily',
      hour: schedule.hour ?? 9,
      minute: schedule.minute ?? 0,
      weekday: schedule.weekday ?? 1,
      dirs: schedule.dirs || [],
      silent: schedule.silent !== false,
      lastRun: schedule.lastRun || 0,
      nextRun: nextAt,
      running,
    };
  }

  return { arm, clear, status, nextRunAt, fire };
}

module.exports = { createScheduler };
