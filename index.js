/**
 * dsh-auto-wake —— 会话自动唤醒
 *
 * 给任意会话（包括调用方自己）挂一条唤醒规则：宿主按固定节拍检查目标会话
 * 「最新一轮是不是结束得不像结束」（LLM 报错 / 被 max-tokens 截断 / 长时间静默
 * 且没有待办），或命中关键词时，通过 `sessionController.prompt` 真正把它叫醒
 * （resolveAgent 会自动 resume 冷会话）。
 *
 * 设计约束：
 *  1. 所有宿主服务一律 `ctx.get(name)` 后判空，缺失只降级对应功能，
 *     绝不让插件整体加载失败（cordis.patch.yml 里也因此不写 inject）。
 *  2. 全局只有一个定时器：每次重算「最近的义务时刻」，不做「一规则一 interval」。
 *  3. 投递走 sessionController.prompt，失败只 warn + 累加 failure 计数，
 *     不重试、不假装成功。
 *  4. 持久化：写 .tmp → JSON.parse 回读校验 → rename，原子落盘。
 *  5. 只依赖 `@deepseek-ai/dsh-tools` 的 defineTool 与 `@deepseek-ai/dsh-session`
 *     的 SessionId，不 import 宿主内部未导出的符号。
 *
 * @module dsh-auto-wake
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promises as fsp } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'

/** 插件名（Loader 用）。 */
export const name = 'auto-wake'

// ──────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────

/** 持久化结构版本，读盘时版本不符则整体丢弃（宁可重来，不猜旧数据）。 */
const STATE_VERSION = 1
/** 轮询间隔下限（秒），避免把模型工具当成高频轮询器用。 */
const MIN_EVERY_SECONDS = 60
/** 轮询间隔上限（秒）。 */
const MAX_EVERY_SECONDS = 24 * 3600
/** 单次 setTimeout 的上限，超过就分段重算（Node 的 timer 溢出会立刻触发）。 */
const MAX_TIMER_DELAY_MS = 60 * 60 * 1000
/** 冷却时间下限（秒）。 */
const MIN_COOLDOWN_SECONDS = 30
/** 「长时间静默」无法配置时使用的兜底判定窗口（毫秒）。 */
const DEFAULT_SILENCE_MS = 10 * 60 * 1000
/** turn/end 事件触发即时检查前的去抖窗口（毫秒）。 */
const EVENT_WAKE_DEBOUNCE_MS = 1_000
/** 单次投递的超时（毫秒）：冷会话 resume 可能很慢，但不能无限期占住一轮 tick。 */
const PROMPT_TIMEOUT_MS = 30_000
/** 一次检查里最多处理多少条到期规则，防止极端情况下卡死事件循环。 */
const MAX_RULES_PER_TICK = 50
/** 连续无进展多少次后熔断。 */
const DEFAULT_MAX_STALLS = 3
/** 一天的毫秒数，时段计算的单位。 */
const DAY_MINUTES = 24 * 60

/**
 * 时区偏移（分钟）。
 *
 * 用固定 +480 表示北京时间（UTC+8）：中国大陆不实行夏令时，
 * 这个换算永远是常量。**不要**用 `new Date().getHours()` 取本地时间 ——
 * 容器里的 TZ 可能是 UTC（实测就是），那样用户设的 09:00 会变成 17:00。
 */
const BEIJING_OFFSET_MINUTES = 480

/**
 * 连续多少次「读不到会话」就停机。
 * 读不到是通道问题（日志被清理、迁移、权限变化），不是目标会话不干活，
 * 所以它走独立的计数与上限，绝不与 stallCount 混用。
 */
const READ_FAILURE_LIMIT = 20

/**
 * 纯次数阈值会随轮询间隔变化：60s 间隔 20 次是 20 分钟，
 * 3600s 间隔 20 次则是 20 小时，同一份代码的失效速度差 60 倍。
 * 因此再叠加一条时间阈值：连续读不到超过这么久就停机，两个条件谁先到算谁。
 */
const READ_FAILURE_WINDOW_MS = 10 * 60 * 1000
/** 小时/天额度默认值。 */
const DEFAULT_MAX_PER_HOUR = 6
const DEFAULT_MAX_PER_DAY = 30
/** 标题、唤醒文本的长度上限。 */
const MAX_TITLE_LENGTH = 120
const MAX_WAKE_TEXT_LENGTH = 4000

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 合法触发条件。 */
const TRIGGER_KINDS = ['unfinished', 'keyword', 'always']
/** 合法投递模式。 */
const DELIVERY_MODES = ['queue', 'steer']

// ──────────────────────────────────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────────────────────────────────

/** 生成规则 id：aw- + 12 位十六进制。 */
/**
 * 把一个时间点换算成「北京时间的当日分钟数」（0..1439）。
 *
 * @param {number} ms epoch 毫秒。
 * @returns {number} 当日分钟数。
 */
function beijingDayMinutes(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MINUTES * 60 * 1000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/**
 * 把 "HH:MM" 解析成当日分钟数。
 *
 * @param {string} text 形如 "09:30"。
 * @returns {number|undefined} 分钟数；格式非法返回 undefined。
 */
function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const matched = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (matched === null) return undefined
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/**
 * 格式化当日分钟数为 "HH:MM"。
 *
 * @param {number} minutes 分钟数。
 * @returns {string} 展示用文本。
 */
function formatClock(minutes) {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 当前是否落在允许唤醒的时段内。
 *
 * @param {object} rule 规则。
 * @param {number} now 当前时间。
 * @returns {{allowed: boolean, reason?: string}} 判定结果。
 */
function withinWindow(rule, now) {
  // 没设时段就是全天可用 —— 保持旧规则的行为不变。
  if (rule.windowStartMinutes === null || rule.windowEndMinutes === null) {
    return { allowed: true }
  }
  const minutes = beijingDayMinutes(now)
  const start = rule.windowStartMinutes
  const end = rule.windowEndMinutes
  // 跨天时段（例如 22:00–06:00）：start > end 时区间绕回第二天。
  const inside = start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
  return inside
    ? { allowed: true }
    : { allowed: false, reason: `outside_window:${formatClock(start)}-${formatClock(end)}` }
}

/**
 * 距下一次进入时段的毫秒数（用于把 nextCheckAt 直接推到时段开头）。
 *
 * @param {object} rule 规则。
 * @param {number} now 当前时间。
 * @returns {number} 毫秒；无时段时返回 0。
 */
function msUntilWindowOpen(rule, now) {
  if (rule.windowStartMinutes === null) return 0
  const minutes = beijingDayMinutes(now)
  let delta = rule.windowStartMinutes - minutes
  if (delta <= 0) delta += DAY_MINUTES
  // 对齐到整分钟，避免一直落在 08:59:59.999 上打转。
  return delta * 60 * 1000
}

function newRuleId() {
  return `aw-${randomBytes(6).toString('hex')}`
}

/** 生成一次性投递 requestId：aw-<ruleId>-<ts>-<rand>。 */
function newRequestId(ruleId) {
  return `aw-${ruleId}-${Date.now()}-${randomBytes(3).toString('hex')}`
}

/** 非数组对象判定。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 裁剪成有限数字，失败时给兜底值。 */
function num(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 把数字夹在 [lo, hi] 区间内。 */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/** 结构化错误：工具返回体统一 { code, message }。 */
function fail(code, message) {
  return { code, message }
}

/**
 * 展开默认状态路径：`~/.dsh/auto-wake/state.json`。
 *
 * 不用 `~/.dsh/storages/`：那是 storage-json 后端的保留根
 * （dsh-base 里 `root: dshHomePath('storages')`），domain 文档就是
 * `storages/<unit>.json`。一旦将来出现同名 domain，双方会以
 * malformed/version-mismatch 互相拒绝启动。插件使用私有目录彻底避开。
 *
 * DSH_HOME 优先（容器内是 /root/.dsh），空白值忽略，否则回落到 ~/.dsh。
 */
function defaultStatePath() {
  const env = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(env, 'auto-wake', 'state.json')
}

// ──────────────────────────────────────────────────────────────────────────
// 持久化：原子写
// ──────────────────────────────────────────────────────────────────────────

/**
 * 原子写 JSON 文件。
 *
 * 顺序严格是「写 .tmp → 读回 JSON.parse 校验 → rename」：
 * 中途任何一步失败，原文件都保持完好，最坏情况只留下一个 .tmp 垃圾。
 *
 * @param {string} path 目标文件绝对路径。
 * @param {object} value 要落盘的值。
 * @returns {Promise<void>}
 */
async function atomicWriteJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  // 临时文件名必须唯一：并发落盘若共用同一个 .tmp，
  // 先完成的一方 rename 之后，后完成的一方就会 ENOENT 撞墙。
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(tmp, text, 'utf8')

  // 回读校验：写坏了就在这里发现，绝不把坏文件 rename 成正式文件。
  // 直接比文本：JSON.parse 后再比 version 是冗余的，且会在 value 恰好没有
  // version 字段时误报。
  const roundTrip = await fsp.readFile(tmp, 'utf8')
  if (roundTrip !== text) {
    throw new Error('auto-wake: 落盘校验失败（回读内容与写入不一致）')
  }

  await fsp.rename(tmp, path)
}

/**
 * 串行化的落盘队列：同一进程内永远只有一个写入在飞。
 *
 * 除了避免并发 rename 打架，更重要的是保证「最后一次成功写入的就是最新状态」——
 * 若两个写乱序完成，旧快照可能覆盖新快照，规则会在重启后凭空回滚。
 *
 * @param {() => Promise<void>} task 要串行执行的写入。
 * @returns {Promise<void>}
 */
function createWriteQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const next = tail.then(task, task).catch(() => undefined)
    tail = next
    return next
  }
}

/** 空状态。 */
function emptyState() {
  return { version: STATE_VERSION, rules: [] }
}

/**
 * 从磁盘读状态。文件不存在返回空状态；文件损坏则备份后从空开始。
 * 读盘失败不抛异常——插件加载不能因为一个坏文件就挂掉。
 *
 * @param {string} path 状态文件路径。
 * @param {object} logger 宿主 logger（可为空实现）。
 * @returns {Promise<object>}
 */
async function loadState(path, logger) {
  let raw
  try {
    raw = await fsp.readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState()
    logger.warn(`auto-wake: 读取状态文件失败，将以空状态启动：${String(error)}`)
    return emptyState()
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn(`auto-wake: 状态文件不是合法 JSON，已忽略：${String(error)}`)
    return emptyState()
  }

  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !Array.isArray(parsed.rules)) {
    logger.warn('auto-wake: 状态文件版本或结构不符，已忽略')
    return emptyState()
  }

  const rules = parsed.rules.filter(isRecord).map(normalizeRule).filter(rule => rule !== undefined)
  return { version: STATE_VERSION, rules }
}

// ──────────────────────────────────────────────────────────────────────────
// 规则规整
// ──────────────────────────────────────────────────────────────────────────

/**
 * 把一条（可能来自磁盘或模型输入的）原始规则规整成内部形状。
 * 缺字段用默认值补，非法字段丢弃；关键字段（id / sessionId / wakeText）缺失时返回 undefined。
 *
 * @param {object} raw 原始规则对象。
 * @returns {object|undefined}
 */
function normalizeRule(raw) {
  if (!isRecord(raw)) return undefined

  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : undefined
  const wakeText = typeof raw.wakeText === 'string' && raw.wakeText.trim().length > 0 ? raw.wakeText : undefined
  if (id === undefined || sessionId === undefined || wakeText === undefined) return undefined

  const trigger = TRIGGER_KINDS.includes(raw.trigger) ? raw.trigger : 'unfinished'
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []

  const now = Date.now()
  const everySeconds = clamp(num(raw.everySeconds, MIN_EVERY_SECONDS), MIN_EVERY_SECONDS, MAX_EVERY_SECONDS)

  return {
    id,
    sessionId,
    title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : `唤醒 ${id}`,
    wakeText,
    trigger,
    keywords,
    everySeconds,
    initialDelaySeconds: clamp(num(raw.initialDelaySeconds, everySeconds), 0, MAX_EVERY_SECONDS),
    mode: DELIVERY_MODES.includes(raw.mode) ? raw.mode : 'queue',
    // 护栏
    maxPerHour: clamp(Math.round(num(raw.maxPerHour, DEFAULT_MAX_PER_HOUR)), 0, 1000),
    maxPerDay: clamp(Math.round(num(raw.maxPerDay, DEFAULT_MAX_PER_DAY)), 0, 10000),
    cooldownSeconds: Math.max(MIN_COOLDOWN_SECONDS, Math.round(num(raw.cooldownSeconds, 300))),
    maxConsecutiveStalls: clamp(Math.round(num(raw.maxConsecutiveStalls, DEFAULT_MAX_STALLS)), 1, 100),
    silenceMs: Math.max(60 * 1000, Math.round(num(raw.silenceMs, DEFAULT_SILENCE_MS))),
    // 北京时间段：null = 全天可用（不限制）。用分钟数存，跨天时段靠 start > end 表达。
    // 只在时段内才允许投递，时段外连检查都不做（省得每次都读一遍日志）。
    windowStartMinutes: parseClock(raw.windowStart) ?? null,
    windowEndMinutes: parseClock(raw.windowEnd) ?? null,
    // 「静置多久后唤醒」——给「过了多少时间自动唤醒」这条最常用的诉求用。
    // 独立于 silenceMs：silenceMs 是「判定静默」的阈值，minIdleSeconds 是
    // 「无论如何等够这么久才唤醒」，两个都设时取较长的那个。
    minIdleSeconds: clamp(Math.round(num(raw.minIdleSeconds, 0)), 0, MAX_EVERY_SECONDS),
    // 运行时状态
    status: raw.status === 'paused' || raw.status === 'tripped' ? raw.status : 'active',
    createdAt: num(raw.createdAt, now),
    nextCheckAt: num(raw.nextCheckAt, now),
    // 存 0 而不是 undefined：工具返回值要走 lossless JSON，undefined 字段
    // 会让宿主报 "value is not lossless JSON"，整次调用被判失败
    // —— 即便规则其实已经建好、消息其实已经投递出去。
    lastCheckAt: num(raw.lastCheckAt, 0),
    lastFireAt: num(raw.lastFireAt, 0) || undefined,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
    lastProgressSeq: num(raw.lastProgressSeq, 0),
    firesTotal: Math.max(0, Math.round(num(raw.firesTotal, 0))),
    firesHour: Math.max(0, Math.round(num(raw.firesHour, 0))),
    hourWindowStart: num(raw.hourWindowStart, now),
    firesDay: Math.max(0, Math.round(num(raw.firesDay, 0))),
    dayWindowStart: num(raw.dayWindowStart, now),
    failureCount: Math.max(0, Math.round(num(raw.failureCount, 0))),
    stallCount: Math.max(0, Math.round(num(raw.stallCount, 0))),
    // 连续「读不到会话」的次数。与 stallCount 分开记：读不到是通道问题，
    // 投递了没动静才是目标会话的问题，两者混用会让熔断逻辑互相打架。
    readFailures: Math.max(0, Math.round(num(raw.readFailures, 0))),
    // 连续读失败的起始时间（供时间阈值使用）。0 表示当前没有在读失败。
    readFailingSince: Math.max(0, Math.round(num(raw.readFailingSince, 0))),
    // 投递进行中标记。护栏看到它就直接跳过，挡住并发穿透。
    inFlight: raw.inFlight === true,
  }
}

/** 对外展示的规则视图（不含内部计数细节，但保留护栏余额）。 */
function ruleView(rule, now) {
  return {
    id: rule.id,
    sessionId: rule.sessionId,
    title: rule.title,
    wakeText: rule.wakeText,
    trigger: rule.trigger,
    keywords: rule.keywords,
    everySeconds: rule.everySeconds,
    mode: rule.mode,
    status: rule.status,
    maxPerHour: rule.maxPerHour,
    maxPerDay: rule.maxPerDay,
    cooldownSeconds: rule.cooldownSeconds,
    maxConsecutiveStalls: rule.maxConsecutiveStalls,
    // 北京时间段的展示形态（null = 全天）
    windowStart: rule.windowStartMinutes === null ? null : formatClock(rule.windowStartMinutes),
    windowEnd: rule.windowEndMinutes === null ? null : formatClock(rule.windowEndMinutes),
    minIdleSeconds: rule.minIdleSeconds,
    // 当前是否在时段内 —— 设置页要直接显示「现在是窗外，不会唤醒」
    inWindow: withinWindow(rule, now).allowed,
    firesTotal: rule.firesTotal,
    firesThisHour: windowCount(rule, 'hour', now),
    firesToday: windowCount(rule, 'day', now),
    failureCount: rule.failureCount,
    stallCount: rule.stallCount,
    readFailures: rule.readFailures,
    tripReason: rule.status === 'tripped' ? rule.lastResult : null,
    // 一律给 null 而不是 undefined：undefined 字段过不了 lossless JSON。
    lastCheckAt: rule.lastCheckAt === undefined || rule.lastCheckAt === 0 ? null : new Date(rule.lastCheckAt).toISOString(),
    lastFireAt: rule.lastFireAt === undefined || rule.lastFireAt === null ? null : new Date(rule.lastFireAt).toISOString(),
    lastResult: rule.lastResult,
    nextCheckAt: new Date(rule.nextCheckAt).toISOString(),
  }
}

/** 取当前窗口内已用的次数（窗口过期视为 0，不在这里改写状态）。 */
function windowCount(rule, kind, now) {
  if (kind === 'hour') {
    return now - rule.hourWindowStart >= HOUR_MS ? 0 : rule.firesHour
  }
  return now - rule.dayWindowStart >= DAY_MS ? 0 : rule.firesDay
}

// ──────────────────────────────────────────────────────────────────────────
// 会话检测：判定「最新一轮是不是结束得不像结束」
// ──────────────────────────────────────────────────────────────────────────
//
// 检测只读，绝不为了「看一眼」把冷会话 resume 起来。
// 优先 sessionQuery（冷读），其次 sessions（仅热会话），都拿不到就返回 unknown，
// 由调用方降级为「跳过本轮」而不是误判。
//
// 判定信号：
//   a) 最后一条 assistant 消息的 finish 原因 === 'error'   → 报错结束
//   b) 最后一条 assistant 消息的 finish 原因 === 'max-tokens' → 被截断
//   c) 存在未闭合的 turn（没有对应 turn/end）              → 中断/崩溃
//   d) 最新活动距今 > silenceMs，且没有待办（无 open turn、无排队 inbox）→ 长时间静默
//
// 关键词条件（trigger='keyword'）额外把最近若干条文本拼起来做子串匹配。

/**
 * 从事件流里提取检测所需的事实。
 *
 * `assistant/message` 里**没有** `finish` 字段（AssistantMessage 只有
 * {id, content, source, role}）。「这一轮怎么结束的」唯一权威来源是 `turn/end`
 * 的 `data.reason.kind`，取值 completed / aborted / blocked / error / max-tokens /
 * interrupted / forked。
 *
 * 语义要点：`aborted` 是**有人主动取消**，`interrupted` 是崩溃后补记，
 * `forked` 是分叉关闭——这三种都不算「结束得不像结束」，不能唤醒；
 * 只有 `error` 与 `max-tokens` 才算异常结束。`blocked` 是策略拦截，也不是可自愈的。
 *
 * @param {Array<object>} events 会话事件（按 seq 升序）。
 * @returns {object} 事实对象。
 */
function inspectEvents(events) {
  let lastTurnEndReason = undefined
  let lastTurnEndError = undefined
  // turn 号会被复用/回绕，用 seq 比较才稳。
  let lastTurnStartSeq = 0
  let lastTurnEndSeq = 0
  let lastActivityAt = 0
  let lastSeq = 0
  let lastToolError = undefined
  const recentTexts = []

  for (const event of events) {
    if (!isRecord(event)) continue
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (seq > lastSeq) lastSeq = seq
    if (typeof event.time === 'number' && event.time > lastActivityAt) lastActivityAt = event.time

    const data = isRecord(event.data) ? event.data : undefined

    switch (event.type) {
      case 'turn/start':
        if (seq > lastTurnStartSeq) lastTurnStartSeq = seq
        break
      case 'turn/end': {
        // 结束原因只认这里。
        if (seq > lastTurnEndSeq) lastTurnEndSeq = seq
        const reason = data !== undefined && isRecord(data.reason) ? data.reason : undefined
        if (reason !== undefined) {
          lastTurnEndReason = typeof reason.kind === 'string' ? reason.kind : undefined
          lastTurnEndError = isRecord(reason.error) ? reason.error : undefined
        }
        break
      }
      case 'assistant/message': {
        // 不读 message.finish（该字段不存在）；这里只收文本用于关键词匹配。
        const message = data !== undefined && isRecord(data.message) ? data.message : undefined
        if (message !== undefined && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!isRecord(block)) continue
            if (block.type === 'text' && typeof block.text === 'string') recentTexts.push(block.text)
            // 附录 3：reasoning 块也扫进来，关键词规则能命中思考过程里的报错。
            if (block.type === 'reasoning' && typeof block.text === 'string') recentTexts.push(block.text)
          }
        }
        break
      }
      case 'user/message': {
        const message = data !== undefined && isRecord(data.message) ? data.message : undefined
        if (message !== undefined && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') recentTexts.push(block.text)
          }
        }
        break
      }
      case 'tool/result': {
        // 附录 3：tool/result 里的报错文本原先完全收不到，关键词规则会漏掉大量真实命中。
        const result = data !== undefined && isRecord(data.result) ? data.result : undefined
        const text = result !== undefined && typeof result.text === 'string' ? result.text : undefined
        if (text !== undefined) {
          recentTexts.push(text)
          if (result !== undefined && result.isError === true) lastToolError = text
        } else if (result !== undefined && typeof result.content === 'string') {
          recentTexts.push(result.content)
        }
        break
      }
      default:
        break
    }
  }

  // 只保留最近 20 条文本，避免长会话把内存/开销拖起来。
  const tailTexts = recentTexts.slice(-20)

  // 用 seq 判断「最后一条 turn 类事件是不是 start」，turn 号复用也不会误判。
  const turnOpen = lastTurnStartSeq > lastTurnEndSeq

  // 只有 error / max-tokens 算异常结束。
  const errored = lastTurnEndReason === 'error'
  const truncated = lastTurnEndReason === 'max-tokens'
  const abortedOrInterrupted = lastTurnEndReason === 'aborted'
    || lastTurnEndReason === 'interrupted'
    || lastTurnEndReason === 'forked'
    || lastTurnEndReason === 'blocked'

  return {
    lastTurnEndReason,
    lastTurnEndError,
    lastToolError,
    lastActivityAt,
    lastSeq,
    recentText: tailTexts.join('\n'),
    turnOpen,
    truncated,
    errored,
    abortedOrInterrupted,
  }
}

/**
 * 判断一条会话当前是不是「正在跑」。
 *
 * Session 上没有 busy/running/active 字段（恒 undefined），
 * 真实判据是 live Agent 的 status。sessionProjections 的 turnBoundary 作双保险。
 *
 * @param {object} ctx cordis 上下文。
 * @param {string} sessionId 会话 id。
 * @returns {boolean}
 */
function isSessionBusy(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined || agent === null) return false
  // ① 最准：Agent 自己在跑
  if (agent.status !== 'running') return false
  // ② 双保险：turn 边界投影显示当前没有开着的回合，就认为没在跑
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined && typeof projections.stateOf === 'function' && agent.session !== undefined) {
    try {
      const boundary = projections.stateOf(agent.session, 'turnBoundary')
      if (boundary !== undefined && boundary.openTurnStartSeq === null) return false
    } catch {
      // 投影不可用不影响主判据
    }
  }
  return true
}

/**
 * 读取一个会话的事件流（只读，不 resume）。
 *
 * `sessionQuery` 上没有 `read()`，真实方法叫 `readSession()`，
 * 返回 `{ session, inheritedEventCount, events }`。原代码的
 * `typeof sessionQuery.read === 'function'` 恒为 false，导致整个分支是死代码，
 * readSessionFacts 恒返回 no_reader —— 规则从来不会触发。
 *
 * @param {object} ctx cordis 上下文。
 * @param {string} sessionId 目标会话。
 * @returns {Promise<{events: Array<object>, busy: boolean, source: string}|{error: string}>}
 */
async function readSessionFacts(ctx, sessionId) {
  const busy = isSessionBusy(ctx, sessionId)

  // 冷读优先：readSession 对 live 与 persisted 都可用（live 优先），不会 resume。
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery !== undefined && typeof sessionQuery.readSession === 'function') {
    try {
      const observation = await sessionQuery.readSession(sessionId)
      if (isRecord(observation) && Array.isArray(observation.events)) {
        return { events: observation.events, busy, source: 'sessionQuery' }
      }
    } catch (error) {
      // 冷读失败不是致命错误，继续尝试热会话。
      ctx.logger.debug?.(`auto-wake: readSession ${sessionId} 失败：${String(error)}`)
    }
  }

  // 兜底：热会话自己。Session 没有 .events，只有 snapshotEvents()。
  const sessions = ctx.get('sessions')
  const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    try {
      return { events: live.snapshotEvents(), busy, source: 'sessions' }
    } catch (error) {
      ctx.logger.debug?.(`auto-wake: snapshotEvents ${sessionId} 失败：${String(error)}`)
    }
  }

  return { error: 'no_reader' }
}

/**
 * 综合事实，判定本轮该不该唤醒。
 *
 * @param {object} rule 规则。
 * @param {object} facts inspectEvents 的结果。
 * @param {number} now 当前时间。
 * @returns {{fire: boolean, reason: string, progressed: boolean}}
 */
function evaluate(rule, facts, now) {
  // 有进展：新事件比上次记录的多。
  const progressed = facts.lastSeq > rule.lastProgressSeq

  // 时段闸：不在北京时间段内直接不唤醒。放在最前面，是为了让所有触发模式
  // （unfinished / keyword / always）统一遵守同一个时间约束，不会有漏网的。
  const gate = withinWindow(rule, now)
  if (!gate.allowed) return { fire: false, reason: gate.reason, progressed, untilWindow: true }

  // 「静置够久了才唤醒」：用户说「过了多少时间自动唤醒」要的就是这个语义。
  // 用最后一条事件的时间算静置时长，而不是用上次检查时间 ——
  // 后者会被轮询间隔带偏，设定的 30 分钟可能变成 31 分或 29 分。
  if (rule.minIdleSeconds > 0 && facts.lastActivityAt > 0) {
    const idleMs = now - facts.lastActivityAt
    if (idleMs < rule.minIdleSeconds * 1000) {
      return { fire: false, reason: `idle_short:${Math.floor(idleMs / 1000)}s`, progressed }
    }
  }

  // 关键词模式：命中即唤醒（不看「是否结束得像结束」）。
  if (rule.trigger === 'keyword') {
    if (rule.keywords.length === 0) return { fire: false, reason: 'no_keyword', progressed }
    // recentText 是**历史窗口**，并不等于「这次新说的话」。
    // 若只用它匹配，一句很久以前说过的关键词会持续命中，额度被陈旧关键词吃光，
    // 表面却一直像在「正常工作」——这是最难排查的一类故障。
    // 因此要求「命中关键词」且「确实有新事件」（即 progressed），否则不算。
    if (!progressed) return { fire: false, reason: 'keyword_no_new_event', progressed }
    for (const keyword of rule.keywords) {
      if (facts.recentText.includes(keyword)) {
        // 同一个 seq 只唤醒一次：避免同一批新事件在多轮 tick 里反复触发。
        if (rule.lastKeywordHitSeq === facts.lastSeq) return { fire: false, reason: 'keyword_consumed', progressed }
        return { fire: true, reason: `keyword:${keyword}`, progressed, keywordSeq: facts.lastSeq }
      }
    }
    return { fire: false, reason: 'keyword_miss', progressed }
  }

  // always 模式：只要会话空闲就唤醒。
  if (rule.trigger === 'always') {
    return facts.busy ? { fire: false, reason: 'busy', progressed } : { fire: true, reason: 'always', progressed }
  }

  // 默认 unfinished 模式：按四条信号判定。
  if (facts.busy) return { fire: false, reason: 'busy', progressed }
  // 语义：[error] 与 [max-tokens] 是唯一两种可自愈的异常结束。
  if (facts.errored) return { fire: true, reason: 'error', progressed }
  if (facts.truncated) return { fire: true, reason: 'max-tokens', progressed }
  // 语义：aborted / interrupted / forked 是有人（或系统）主动收尾，不是「不像结束」。
  //   aborted 尤其不能唤醒 —— 用户就是不想让它继续；而 interrupted 是崩溃补记，已被 turnOpen 覆盖。
  if (facts.abortedOrInterrupted) return { fire: false, reason: `ended:${facts.lastTurnEndReason}`, progressed }
  if (facts.turnOpen) return { fire: true, reason: 'turn-open', progressed }

  const idleMs = facts.lastActivityAt === 0 ? 0 : now - facts.lastActivityAt
  if (facts.lastActivityAt !== 0 && idleMs >= rule.silenceMs) {
    return { fire: true, reason: 'silent', progressed }
  }

  return { fire: false, reason: 'healthy', progressed }
}

// ──────────────────────────────────────────────────────────────────────────
// 插件主体
// ──────────────────────────────────────────────────────────────────────────

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} config 插件配置（可被 cordis.patch.yml 覆盖）。
 */
export function apply(ctx, config) {
  const statePath = config !== null && isRecord(config) && typeof config.statePath === 'string' && config.statePath.length > 0
    ? config.statePath
    : defaultStatePath()
  const pollSeconds = clamp(
    Math.round(num(config !== null && isRecord(config) ? config.pollSeconds : undefined, 60)),
    15,
    3600,
  )

  /** 内存态；load 完成后才有值。 */
  let state = emptyState()
  /** 唯一的定时器。 */
  let timer
  /** 事件加速用的去抖定时器（与 timer 互斥使用，dispose 时一并清理）。 */
  let wakeTimer
  /** 正在跑 tick 时置 true，防止重入。 */
  let ticking = false
  /** 本轮 tick 里是否有改动需要落盘。 */
  let dirty = false
  /** 最近一次落盘失败原因，工具层据此决定是否返回 ok:false。 */
  let lastPersistError
  /** 插件是否已 dispose。 */
  let disposed = false
  /** 状态是否已从磁盘载入。 */
  let loaded = false

  const logger = ctx.logger

  // ── 定时器：全局只此一个 ─────────────────────────────────────────────

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  /**
   * 重算最近义务时刻并重启唯一定时器。
   * 没有 active 规则就彻底清掉定时器，闲着不占资源。
   */
  function scheduleNext() {
    clearTimer()
    if (disposed || !loaded) return

    const now = Date.now()
    let next
    for (const rule of state.rules) {
      if (rule.status !== 'active') continue
      const at = rule.nextCheckAt
      if (next === undefined || at < next) next = at
    }

    // 没有义务：退化成低频守护，等下一次 schedule_create 进来再拉高频率。
    const target = next === undefined ? now + pollSeconds * 1000 : next
    const delay = clamp(target - now, 0, MAX_TIMER_DELAY_MS)

    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, delay)
    // 定时器不应拖住宿主进程退出。
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 立即唤醒调度（在规则变更后调用，不等下一个自然节拍）。 */
  function requestTick(delayMs = 0) {
    clearTimer()
    if (disposed || !loaded) return
    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, Math.max(0, delayMs))
    if (typeof timer.unref === 'function') timer.unref()
  }

  // ── 持久化 ───────────────────────────────────────────────────────────

  /** 所有落盘经同一队列串行执行，见 createWriteQueue 的注释。 */
  const enqueueWrite = createWriteQueue()

  /**
   * 落盘。**返回是否真的写成功**。
   *
   * 写失败必须让调用方看得见：调用方（create/delete）一旦吞掉失败照旧返回 ok:true，
   * 就会出现「模型被告知规则已创建，重启后规则凭空消失」，
   * 而用户唯一的线索只有 logger.error。
   *
   * @returns {Promise<boolean>} true = 已确认落盘。
   */
  function persist() {
    return enqueueWrite(async () => {
      if (disposed) return false
      try {
        await atomicWriteJson(statePath, state)
        dirty = false
        lastPersistError = undefined
        return true
      } catch (error) {
        lastPersistError = String(error)
        if (logger && typeof logger.error === 'function') {
          logger.error(`auto-wake: 状态落盘失败（路径 ${statePath}）：${String(error)}`)
        } else {
          logger.warn(`auto-wake: 状态落盘失败（路径 ${statePath}）：${String(error)}`)
        }
        return false
      }
    })
  }

  // ── 额度 / 护栏 ──────────────────────────────────────────────────────

  /**
   * 推进额度窗口：跨小时/跨天就把计数清零。
   * @param {object} rule 规则（就地修改）。
   * @param {number} now 当前时间。
   */
  function rollWindows(rule, now) {
    if (now - rule.hourWindowStart >= HOUR_MS) {
      rule.hourWindowStart = now
      rule.firesHour = 0
    }
    if (now - rule.dayWindowStart >= DAY_MS) {
      rule.dayWindowStart = now
      rule.firesDay = 0
    }
  }

  /**
   * 检查护栏，返回拒绝原因或 undefined（放行）。
   *
   * @param {object} rule 规则。
   * @param {number} now 当前时间。
   * @param {{forDelivery?: boolean}} [options] `forDelivery: true` 表示这次判定是为了
   *   **真的投递**；只有真投递才需要考虑「上一条还在飞」。dryRun 永远不投递，
   *   它不该因为别人正在飞而报告「不会唤醒」—— 那会让排障工具在最需要它的时候说谎。
   * @returns {string|undefined}
   */
  function guardrailRefusal(rule, now, options = {}) {
    rollWindows(rule, now)

    // 上一次投递还没回来时，任何**投递**路径都不许再穿一次。
    // 但 dryRun 必须能穿透这条：它只回答「现在会不会唤醒」，不产生副作用。
    if (options.forDelivery === true && rule.inFlight === true) return 'in_flight'
    if (rule.firesHour >= rule.maxPerHour) return 'hour_quota'
    if (rule.firesDay >= rule.maxPerDay) return 'day_quota'

    if (rule.lastFireAt !== undefined && now - rule.lastFireAt < rule.cooldownSeconds * 1000) return 'cooling_down'

    // 时段双保险：evaluate 已经拦过一次，这里再拦一次是为了覆盖
    // 「判定时还在段内、真正投递时刚好跨出段外」的窗口。
    const gate = withinWindow(rule, now)
    if (!gate.allowed) return gate.reason

    return undefined
  }

  // ── 投递 ─────────────────────────────────────────────────────────────

  /**
   * 通过宿主 sessionController.prompt 真正唤醒目标会话。
   *
   * prompt 内部会 resolveAgent（冷会话自动 resume），所以这里不需要自己 resume。
   * 投递失败只记 warn + 计数，绝不重试 —— 重试会把一次性唤醒变成骚扰。
   *
   * @param {object} rule 规则。
   * @param {string} reason 这次触发的原因（写进正文，方便目标会话理解上下文）。
   * @returns {Promise<boolean>} 是否投递成功。
   */
  async function deliver(rule, reason) {
    const sessionController = ctx.get('sessionController')
    if (sessionController === undefined || typeof sessionController.prompt !== 'function') {
      logger.warn(`auto-wake: sessionController 不可用，规则 ${rule.id}（会话 ${rule.sessionId}）无法投递`)
      rule.failureCount += 1
      dirty = true
      return false
    }

    const requestId = newRequestId(rule.id)
    const text = renderWakeText(rule, reason)

    try {
      // 给 prompt 传取消信号。宿主签名就是 prompt(request, signal)，
      // 它内部第一句 await resolveAgent，冷会话要完整 resume（可能等 writer lock）。
      // 没有超时的话一条冷规则能把整轮 tick 无限期占住。
      const result = await sessionController.prompt({
        sessionId: SessionId(rule.sessionId),
        requestId,
        content: [{ type: 'text', text }],
        mode: rule.mode,
      }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      // prompt 成功返回 { accepted: true }；其它形状也当作已受理，但记进 lastResult。
      const accepted = isRecord(result) && result.accepted === false ? false : true
      if (!accepted) {
        logger.warn(`auto-wake: 规则 ${rule.id} 的投递未被受理（requestId=${requestId}）`)
        rule.failureCount += 1
        dirty = true
        return false
      }
      return true
    } catch (error) {
      // 明确失败：不重试、不伪造成功。
      logger.warn(`auto-wake: 规则 ${rule.id} 投递失败（会话 ${rule.sessionId}，requestId=${requestId}）：${String(error)}`)
      rule.failureCount += 1
      dirty = true
      return false
    }
  }

  /** 组装唤醒正文：用户文本 + 一句机器生成的触发说明。 */
  function renderWakeText(rule, reason) {
    return `${rule.wakeText}\n\n---\n[auto-wake] 触发规则「${rule.title}」（${rule.id}），原因：${describeReason(reason)}。请接着没做完的部分继续。`
  }

  // ── 一轮检查 ─────────────────────────────────────────────────────────

  /**
   * 处理一条到期规则。
   * @param {object} rule 规则。
   * @param {number} now 当前时间。
   */
  async function handleRule(rule, now) {
    rule.lastCheckAt = now
    dirty = true

    let factsResult
    try {
      factsResult = await readSessionFacts(ctx, rule.sessionId)
    } catch (error) {
      rule.lastResult = `read_error:${String(error).slice(0, 120)}`
      rule.failureCount += 1
      rule.nextCheckAt = now + rule.everySeconds * 1000
      return
    }

    if (factsResult.error !== undefined) {
      // 这里绝不能清 stallCount。
      // 原先写了 `rule.stallCount = 0`，等于开了第二个熔断复位点，而且方向还是反的：
      // 会话日志被清理 / 迁移 / 权限变化导致持续 no_reader 时，每个 tick 都把计数清零，
      // 于是一条永远读不到的规则**永远不会熔断**，只能靠额度空转到用完 —— 然后下个窗口继续。
      //
      // 正确做法：读不到 = 这条规则本身失效，累计 readFailures；连续读失败到上限就停掉，
      // 不再投递，也不再消耗额度。stallCount 只留给「真的投递了但对方没动」那种情况。
      rule.readFailures = num(rule.readFailures, 0) + 1
      // 记下第一次读失败的时间，用于时间阈值；读到就清空。
      if (!Number.isFinite(rule.readFailingSince) || rule.readFailingSince <= 0) {
        rule.readFailingSince = now
      }
      const unreadableTooLong = now - rule.readFailingSince >= READ_FAILURE_WINDOW_MS
      if (rule.readFailures >= READ_FAILURE_LIMIT || unreadableTooLong) {
        rule.status = 'tripped'
        rule.lastResult = `tripped:unreadable_x${rule.readFailures}`
        rule.nextCheckAt = now + rule.everySeconds * 1000
        logger.warn(`auto-wake: 规则 ${rule.id}（会话 ${rule.sessionId}）连续 ${rule.readFailures} 次读不到会话，已停机`)
        return
      }
      // 读不到会话只降级跳过本轮，既不算无进展，也不动 stallCount。
      rule.lastResult = `unknown:no_reader_x${rule.readFailures}`
      rule.nextCheckAt = now + rule.everySeconds * 1000
      return
    }
    // 读到就复位「连续读失败」计数；它与熔断计数是两回事。
    rule.readFailures = 0
    rule.readFailingSince = 0

    // busy 来自 readSessionFacts（agents 服务），inspectEvents 只看事件流拿不到它，
    // 必须在这里合流，否则 evaluate 里的 facts.busy 永远是 undefined。
    const facts = { ...inspectEvents(factsResult.events), busy: factsResult.busy === true }
    const verdict = evaluate(rule, facts, now)

    // 记录进展：有进展就清零熔断计数，这是「连续无进展」熔断的唯一复位点。
    if (verdict.progressed) {
      rule.lastProgressSeq = facts.lastSeq
      rule.stallCount = 0
    }

    if (!verdict.fire) {
      rule.lastResult = verdict.reason
      // 时段外把下次检查直接推到时段开头：与其每分钟白读一遍会话日志，
      // 不如睡到真正可能唤醒的那一刻。
      rule.nextCheckAt = verdict.untilWindow === true
        ? now + Math.max(1000, msUntilWindowOpen(rule, now))
        : now + rule.everySeconds * 1000
      return
    }

    // 命中触发条件，先过护栏。
    const refusal = guardrailRefusal(rule, now, { forDelivery: true })
    if (refusal !== undefined) {
      rule.lastResult = `skipped:${refusal}`
      // 被时段拦下时睡到时段开头，别按 everySeconds 空转读日志。
      rule.nextCheckAt = refusal.startsWith('outside_window')
        ? now + Math.max(1000, msUntilWindowOpen(rule, now))
        : now + rule.everySeconds * 1000
      return
    }

    // 熔断判定必须放在**投递成功之后**。
    // 若先 `stallCount += 1` 再判 `>= max` 并 return，用户设的 N 实际只会投递 N-1 次
    // ——最后一次唤醒永远不会发生，而 tripped 是不可恢复终态。
    // 正确语义：投递 → 成功 → 才算「又多了一次无进展」→ 到上限才熔断。

    // 投递是异步的（prompt 内部要 resolveAgent，冷会话可能等几十秒）。
    // 若等 await 回来才记额度，整个投递窗口里护栏都「看不见这次投递」，
    // 第二条并发路径（autowake_run 把 nextCheckAt 拉到现在 / 另一条到期规则）
    // 就能再穿一次护栏——自愈型 error 会话会在 30s 内连收两条相同唤醒。
    // 因此：进 await 之前先记账、占住额度，失败再回滚。
    rule.firesTotal += 1
    rule.firesHour += 1
    rule.firesDay += 1
    rule.lastFireAt = now
    rule.inFlight = true
    rule.lastResult = `firing:${verdict.reason}`
    dirty = true
    // 立即落盘：进程若在投递途中被杀，重启后额度账不会凭空清零。
    // 但落盘失败也不能因此拦着不投递 —— 额度账丢了比少唤醒一次更可接受，
    // 只把失败大声记下来（B3 的 create/delete 才必须严格）。
    const reserved = await persist()
    if (!reserved) {
      logger.warn(`auto-wake: 规则 ${rule.id} 预占额度落盘失败，仍继续投递（${lastPersistError ?? '未知错误'}）`)
    }

    const ok = await deliver(rule, verdict.reason)
    rule.inFlight = false
    if (ok) {
      if (verdict.keywordSeq !== undefined) rule.lastKeywordHitSeq = verdict.keywordSeq
      rule.lastResult = `fired:${verdict.reason}`
      // 熔断计数不清零：只有真正出现新事件才算「有进展」。
      // 但这一次投递**已经发生**，所以它必须计入 stallCount —— 判上限放在这次计数之后，
      // 保证用户设的 maxConsecutiveStalls=N 时确实发出 N 次唤醒才熔断。
      rule.stallCount += 1
      if (rule.stallCount >= rule.maxConsecutiveStalls) {
        rule.status = 'tripped'
        rule.lastResult = `tripped:no_progress_x${rule.stallCount}`
        logger.warn(`auto-wake: 规则 ${rule.id}（会话 ${rule.sessionId}）连续 ${rule.stallCount} 次唤醒无进展，已熔断`)
      }
    } else {
      // 投递失败：把预占的额度退回去，否则一次通道抖动会白吃一次额度。
      // 失败不计 stallCount —— 没投出去就谈不上「投了但对方没动」。
      rule.firesTotal = Math.max(0, rule.firesTotal - 1)
      rule.firesHour = Math.max(0, rule.firesHour - 1)
      rule.firesDay = Math.max(0, rule.firesDay - 1)
      rule.lastResult = `failed:${verdict.reason}`
    }

    rule.nextCheckAt = now + rule.everySeconds * 1000
  }

  /**
   * 一次完整的调度轮次：处理所有到期规则，落盘，然后重算定时器。
   */
  async function tick() {
    if (disposed || ticking) return
    ticking = true
    try {
      const now = Date.now()
      const due = state.rules
        .filter(rule => rule.status === 'active' && rule.nextCheckAt <= now)
        .slice(0, MAX_RULES_PER_TICK)

      // 规则之间并发，而不是串行。prompt 内部会真实 await resolveAgent
      // 去 resume 冷会话，串行时一条冷规则会把后面所有规则一起顺延，
      // 而 ticking=true 会让下一次 tick 直接 return，造成集体漂移。
      await Promise.allSettled(due.map(async (rule) => {
        if (disposed) return
        try {
          await handleRule(rule, now)
        } catch (error) {
          // 单条规则炸了不能拖垮整轮。
          rule.lastResult = `internal:${String(error).slice(0, 120)}`
          rule.failureCount += 1
          rule.nextCheckAt = now + rule.everySeconds * 1000
          dirty = true
          logger.warn(`auto-wake: 规则 ${rule.id} 处理异常：${String(error)}`)
        }
      }))

      if (dirty) await persist()
    } finally {
      ticking = false
      scheduleNext()
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────

  // 载入状态后再启动调度；fail 不抛，插件照常可用（只是没有历史规则）。
  const ready = loadState(statePath, logger).then(async (loadedState) => {
    state = loadedState
    loaded = true
    if (disposed) return

    // 重启恢复：把已经过期的 nextCheckAt 收敛到「现在 + 一个轮询间隔」，
    // 避免重启瞬间把所有规则同时打出去。
    //
    // 只在**确实过期**时动它，且用 min 兜住上限而不是直接覆盖。
    // 若无条件写成 now + everySeconds，用户设的 initialDelaySeconds
    // 每重启一次就被重算一次（initialDelaySeconds:0 的规则重启后变成 now+60s），
    // 而且会绕过 MAX_EVERY_SECONDS 夹取。
    // nextCheckAt === 0（表示「尽快」）同样要收敛，否则 0 会被当作已过期。
    const now = Date.now()
    for (const rule of state.rules) {
      // 上次进程死在投递途中时，磁盘上会留下 inFlight === true。
      //
      // 为什么只在这里自愈、而不在投递后再补一次 persist：
      // 投递后补写意味着每条规则每次唤醒都多一次全量写盘（state.json 是整文档重写），
      // 而且那次写失败时连告警都不该发（投递已经成功），等于凭空多一个
      // 「可能变慢、又没法报警」的环节。启动时本来就要读一次盘，在这里处理零成本。
      //
      // 语义选择：**保留**当时预占的额度。那次唤醒可能真的发出去了，
      // 宁可少唤醒一次（额度当作用掉），也不要重复唤醒（会反复自启、烧 token）。
      if (rule.inFlight === true) {
        rule.inFlight = false
        rule.lastResult = 'crash_during_delivery'
        logger.warn(`auto-wake: 规则 ${rule.id} 上次在投递途中中断，已复位；这次唤醒按已消耗额度计`)
      }
      // 必须加抖动。
      // 否则宕机一段时间后，所有过期规则会被压到同一个节拍上，
      // 重启后的第一个 tick 里多个会话同秒被唤醒——目标侧 resume 扎堆、
      // 额度一次烧光，现象看起来像「插件抽风」。抖动上限取 min(every, 60s)。
      const jitterMs = Math.floor(Math.random() * Math.min(rule.everySeconds, 60) * 1000)
      if (!Number.isFinite(rule.nextCheckAt) || rule.nextCheckAt <= 0) {
        rule.nextCheckAt = now + jitterMs
        continue
      }
      if (rule.nextCheckAt < now) {
        rule.nextCheckAt = Math.min(now + jitterMs, now + MAX_EVERY_SECONDS * 1000)
      }
    }
    if (state.rules.length > 0) {
      dirty = true
      await persist()
    }
    scheduleNext()
  }).catch((error) => {
    logger.warn(`auto-wake: 初始化失败，插件以空状态运行：${String(error)}`)
    loaded = true
    scheduleNext()
  })

  // dispose 时显式清理唯一定时器。
  ctx.effect(() => () => {
    disposed = true
    clearTimer()
    if (wakeTimer !== undefined) {
      clearTimeout(wakeTimer)
      wakeTimer = undefined
    }
  })

  // ── turn/end 事件监听：把最坏唤醒延迟从「≥ everySeconds」压到秒级 ──
  //
  // 只做轻量标记，不在回调里 await 任何长任务（resume 冷会话可能要几秒）：
  // 命中就把对应规则的 nextCheckAt 拉到现在，让下一次 tick 立刻处理它。
  //
  // `ctx.on` 返回的 disposer 本身就是一个 effect，会随 fiber 一起回收，
  // 所以不需要再包一次 ctx.effect。
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      if (disposed || !loaded) return
      if (!isRecord(event) || event.type !== 'turn/end') return
      const data = isRecord(event.data) ? event.data : undefined
      const reason = data !== undefined && isRecord(data.reason) ? data.reason : undefined
      const kind = reason !== undefined && typeof reason.kind === 'string' ? reason.kind : undefined
      // 只对「可自愈的异常结束」抢跑；aborted/interrupted/forked/blocked 交给常规节拍。
      if (kind !== 'error' && kind !== 'max-tokens') return

      const sessionId = session !== undefined && session !== null && typeof session.id === 'string'
        ? session.id
        : (isRecord(event) && typeof event.sessionId === 'string' ? event.sessionId : undefined)
      if (sessionId === undefined) return

      const now = Date.now()
      let hit = false
      for (const rule of state.rules) {
        if (rule.status !== 'active' || rule.sessionId !== sessionId) continue
        // 只提前、不推后。
        if (rule.nextCheckAt > now) {
          rule.nextCheckAt = now
          hit = true
        }
      }
      if (!hit) return

      // 缓冲一下再跑：同一轮里可能连续来几个 turn/end，攒成一次 tick。
      if (wakeTimer !== undefined) clearTimeout(wakeTimer)
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined
        if (!disposed) void tick()
      }, EVENT_WAKE_DEBOUNCE_MS)
      if (typeof wakeTimer.unref === 'function') wakeTimer.unref()
    })
  } else {
    logger.debug?.('auto-wake: ctx.on 不可用，事件加速关闭，仅按常规节拍轮询')
  }

  // ── 工具注册 ─────────────────────────────────────────────────────────

  // 用 ctx.inject 声明对 tools 的依赖，而不是裸 ctx.get：
  // 插件加载那一刻 tools 若还没挂载，ctx.get 会静默落空、工具永远注册不上，
  // 症状是「插件装了但模型看不到工具」，且只有一条 warn。
  // ctx.inject 会等 services 就绪再执行回调（dsh-tool-schedule 同款写法），
  // 既解决时序问题，又不会像模块级 export const inject 那样整体替换依赖表。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.tools ?? toolsCtx.get?.('tools')
      if (tools === undefined || typeof tools.register !== 'function') {
        logger.warn('auto-wake: tools 服务不可用，本次只运行调度器，不注册模型工具')
        return
      }
      registerTools(tools)
    })
  } else {
    // 老宿主没有 ctx.inject 时退回裸取，功能不降级。
    const tools = ctx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      logger.warn('auto-wake: tools 服务不可用，本次只运行调度器，不注册模型工具')
    } else {
      registerTools(tools)
    }
  }

  // ── 设置页 HTTP 接口 ──────────────────────────────────────────────────
  // 设置页是 Web 端页面，走不到 cordis 工具层，所以这里用 host.webServer
  // 把同一份操作暴露成 REST。业务逻辑与工具层共用下面几个纯函数，
  // 保证「模型调工具」和「用户在设置页点按钮」走的是同一条路径。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const host = webCtx.webServer ?? webCtx.get?.('webServer')
      if (host === undefined || typeof host.register !== 'function') {
        logger.warn('auto-wake: webServer 不可用，设置页接口未注册（模型工具不受影响）')
        return
      }
      try {
        registerHttpRoutes(host)
      } catch (error) {
        logger.warn(`auto-wake: 设置页接口注册失败：${String(error)}`)
      }
    })
  }

  /**
   * 把四个操作挂成 REST 端点。
   * @param {object} host webServer 服务。
   */
  function registerHttpRoutes(host) {
    const json = (res, status, payload) => {
      res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      })
      res.end(JSON.stringify(payload))
    }
    const readBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buf.length
        // 规则正文最多 4000 字，512KB 足够且能挡住误发的大包。
        if (size > 512 * 1024) throw new Error('请求体过大')
        chunks.push(buf)
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      return text.length === 0 ? {} : JSON.parse(text)
    }

    const guard = (handler) => async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        json(res, 500, { ok: false, code: 'internal_error', message: String(error) })
      }
    }

    // 列表：顺带返回额度/冷却/熔断状态，设置页直接用。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/list',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        await ready
        const now = Date.now()
        json(res, 200, {
          ok: true,
          total: state.rules.length,
          rules: state.rules.map(rule => ruleView(rule, now)),
          statePath,
        })
      }),
    }, 'dsh-auto-wake: list')

    // 新建：参数与 autowake_create 完全一致。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/create',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        await ready
        const body = await readBody(req)
        const invalid = validateCreateArgs(body)
        if (invalid !== undefined) { json(res, 400, { ok: false, ...invalid }); return }
        const resolved = await resolveSessionId(String(body.sessionId).trim())
        if (resolved.error !== undefined) { json(res, 400, { ok: false, ...resolved.error }); return }

        const now = Date.now()
        const rule = normalizeRule({
          ...body,
          sessionId: resolved.sessionId,
          id: newRuleId(),
          trigger: body.trigger === undefined ? 'unfinished' : body.trigger,
          createdAt: now,
          nextCheckAt: now + clamp(num(body.initialDelaySeconds, num(body.everySeconds, 300)), 0, MAX_EVERY_SECONDS) * 1000,
          status: 'active',
        })
        if (rule === undefined) { json(res, 500, { ok: false, ...fail('internal_error', '规则构造失败') }); return }

        state.rules.push(rule)
        dirty = true
        const saved = await persist()
        if (!saved) {
          state.rules = state.rules.filter(candidate => candidate.id !== rule.id)
          json(res, 500, { ok: false, ...fail('persist_failed', `规则未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) })
          return
        }
        requestTick(0)
        json(res, 200, { ok: true, id: rule.id, rule: ruleView(rule, Date.now()) })
      }),
    }, 'dsh-auto-wake: create')

    // 删除。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/delete',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        await ready
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id.length === 0) { json(res, 400, { ok: false, ...fail('invalid_id', 'id 不能为空') }); return }
        const index = state.rules.findIndex(rule => rule.id === id)
        if (index < 0) { json(res, 404, { ok: false, ...fail('not_found', `找不到规则 ${id}`) }); return }
        const [removed] = state.rules.splice(index, 1)
        dirty = true
        const saved = await persist()
        if (!saved) {
          state.rules.splice(index, 0, removed)
          json(res, 500, { ok: false, ...fail('persist_failed', `删除未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) })
          return
        }
        requestTick(0)
        json(res, 200, { ok: true, id, deleted: true })
      }),
    }, 'dsh-auto-wake: delete')

    // 更新一条已有规则。
    // 只允许改「配置类」字段；运行时状态（额度窗口、熔断计数、lastSeq）
    // 一律沿用旧值 —— 编辑规则不该把人家的额度余额或熔断状态顺手清零。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/update',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        await ready
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id.length === 0) { json(res, 400, { ok: false, ...fail('invalid_id', 'id 不能为空') }); return }
        const index = state.rules.findIndex(rule => rule.id === id)
        if (index < 0) { json(res, 404, { ok: false, ...fail('not_found', `找不到规则 ${id}`) }); return }

        const previous = state.rules[index]
        const merged = mergeRuleEdit(previous, body)
        // excludeId：让重复检查跳过规则自己，否则每次编辑都会被自己拦下。
        const invalid = validateCreateArgs({ ...merged, excludeId: previous.id })
        if (invalid !== undefined) { json(res, 400, { ok: false, ...invalid }); return }

        // sessionId 变了要重新解析；没变就跳过，省一次 listSessions。
        let sessionId = previous.sessionId
        if (typeof body.sessionId === 'string' && body.sessionId.trim().length > 0 && body.sessionId.trim() !== previous.sessionId) {
          const resolved = await resolveSessionId(body.sessionId.trim())
          if (resolved.error !== undefined) { json(res, 400, { ok: false, ...resolved.error }); return }
          sessionId = resolved.sessionId
        }

        // 用旧规则做底再覆盖配置字段：normalizeRule 会把运行时状态
        // 从 raw 里读回来，所以过渡对象必须带上旧的那一份。
        const next = normalizeRule({
          ...previous,
          ...merged,
          id: previous.id,
          sessionId,
          createdAt: previous.createdAt,
          status: bookkeepingForEdit(previous, body),
          nextCheckAt: nextCheckAfterEdit(previous, body, merged),
          lastKeywordHitSeq: previous.lastKeywordHitSeq,
        })
        if (next === undefined) { json(res, 500, { ok: false, ...fail('internal_error', '规则构造失败') }); return }

        state.rules[index] = next
        dirty = true
        const saved = await persist()
        if (!saved) {
          state.rules[index] = previous
          json(res, 500, { ok: false, ...fail('persist_failed', `修改未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) })
          return
        }
        requestTick(0)
        json(res, 200, { ok: true, id: next.id, rule: ruleView(next, Date.now()) })
      }),
    }, 'dsh-auto-wake: update')

    // 立即跑一轮（dryRun=true 只判定不投递）。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/run',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        await ready
        const body = await readBody(req)
        const id = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
        const dryRun = body.dryRun === true
        const targets = state.rules.filter(rule => (id === undefined ? rule.status === 'active' : rule.id === id))
        if (id !== undefined && targets.length === 0) {
          json(res, 404, { ok: false, ...fail('not_found', `找不到规则 ${id}`) })
          return
        }
        const now = Date.now()
        const results = []
        for (const rule of targets.slice(0, MAX_RULES_PER_TICK)) {
          if (dryRun) {
            // 与 autowake_run 的 dryRun 分支保持同一套判定，网页看到的
            // 结论必须和模型调工具时看到的一致。
            const factsResult = await readSessionFacts(ctx, rule.sessionId)
            if (factsResult.error !== undefined) {
              results.push({ id: rule.id, sessionId: rule.sessionId, fire: false, reason: 'unknown:no_reader' })
              continue
            }
            const facts = { ...inspectEvents(factsResult.events), busy: factsResult.busy === true }
            const verdict = evaluate(rule, facts, now)
            const refusal = verdict.fire ? guardrailRefusal(rule, now, { forDelivery: false }) : undefined
            results.push({
              id: rule.id,
              sessionId: rule.sessionId,
              fire: verdict.fire && refusal === undefined,
              reason: refusal === undefined ? verdict.reason : `skipped:${refusal}`,
              busy: facts.busy,
            })
            continue
          }
          rule.nextCheckAt = now
          await handleRule(rule, now)
          results.push({ id: rule.id, sessionId: rule.sessionId, result: rule.lastResult })
        }
        if (!dryRun) {
          dirty = true
          await persist()
          requestTick(0)
        }
        json(res, 200, { ok: true, checked: results.length, dryRun, results })
      }),
    }, 'dsh-auto-wake: run')

    // 会话列表：设置页要让人挑选目标会话，而不是让人去翻磁盘找 id。
    host.register({
      kind: 'exact',
      path: '/dsh-auto-wake/sessions',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, code: 'method_not_allowed' }); return }
        const sessionQuery = ctx.get('sessionQuery')
        if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
          json(res, 200, { ok: true, sessions: [], note: 'sessionQuery 不可用，请手动填会话 id' })
          return
        }
        const rows = await sessionQuery.listSessions()
        // listSessions 返回的是 { header, live, persisted } 包装对象，
        // 会话 id 在 header.id 里 —— 直接读 row.sessionId 会得到空串，
        // 于是列表恒为空（这个坑踩过一次，别再改回去）。
        const all = (Array.isArray(rows) ? rows : [])
          .map(row => normalizeSessionRow(row))
          .filter(entry => entry.sessionId.startsWith('session-'))

        // 过滤掉已归档会话：归档 = 用户主动收进抽屉的决定，
        // 再给它挂自动唤醒等于把刚收起来的东西又拽出来。
        const archived = readArchivedSessionIds(ctx)
        const summaries = all.filter(entry => archived.has(entry.sessionId) === false)

        const titleMap = await loadTitles(sessionQuery, summaries)
        json(res, 200, {
          ok: true,
          sessions: summaries.map(entry => ({
            sessionId: entry.sessionId,
            title: titleMap.get(entry.sessionId) || entry.title || '',
            updatedAt: entry.updatedAt,
          })),
          // 让界面能说清「为什么少了几条」，而不是让人以为会话丢了。
          hiddenArchived: all.length - summaries.length,
        })
      }),
    }, 'dsh-auto-wake: sessions')
  }

  /**
   * 读「已归档会话 id」集合。
   *
   * 归档不是会话自己的字段，而是 workspace 注册表里的全局集合
   * （`workspace.archivedSessionIds`）—— 归档后会话仍留在工作区里，
   * 只是被收起来，所以只能从这里读。
   *
   * 拿不到（老宿主 / 域未加载）就返回空集合：宁可多列几条，也不要整页空掉。
   *
   * @param {object} context cordis 上下文。
   * @returns {Set<string>} 已归档的会话 id。
   */
  function readArchivedSessionIds(context) {
    const empty = new Set()
    try {
      const workspace = context.get?.('workspace')
      if (workspace === undefined || workspace === null) return empty
      // 属性形态（service 上的 getter）优先，其次才是方法。
      const raw = workspace.archivedSessionIds
        ?? (typeof workspace.listArchivedSessionIds === 'function' ? workspace.listArchivedSessionIds() : undefined)
      if (!Array.isArray(raw)) return empty
      const set = new Set()
      for (const id of raw) {
        if (typeof id === 'string' && id.length > 0) set.add(id)
      }
      return set
    } catch (error) {
      logger.debug?.(`auto-wake: 读取归档会话失败，按「无归档」处理：${String(error)}`)
      return empty
    }
  }

  /**
   * 从 title 字段里取出可展示的文本。
   *
   * `foldSessionTitle` 返回的是 `titleSnapshotFromState(...)` 的形状
   * —— `{ title, messageSeqs, source, eventSeq, updatedAt }`，
   * 也就是说**标题文本本身还嵌在 `title.title` 里**，不是裸字符串。
   * 两种都兼容：裸字符串直接用，对象取 `.title`。
   *
   * @param {unknown} raw title 字段。
   * @returns {string} 可展示文本；取不到返回空串。
   */
  function readTitleText(raw) {
    if (typeof raw === 'string') return raw.trim()
    if (isRecord(raw) && typeof raw.title === 'string') return raw.title.trim()
    return ''
  }

  /**
   * 把编辑请求合并进旧规则：只取「允许被改」的字段。
   *
   * 白名单而不是黑名单 —— 黑名单每加一个新字段就得记得同步，
   * 漏一次就是某个运行时状态被网页悄悄改掉。
   *
   * @param {object} previous 旧规则。
   * @param {object} body 编辑请求体。
   * @returns {object} 合并后的配置字段。
   */
  function mergeRuleEdit(previous, body) {
    const editable = [
      'wakeText', 'title', 'everySeconds', 'initialDelaySeconds', 'mode',
      'maxPerHour', 'maxPerDay', 'cooldownSeconds', 'maxConsecutiveStalls',
      'silenceMs', 'minIdleSeconds',
    ]
    const merged = {}
    for (const key of editable) {
      if (body[key] !== undefined) merged[key] = body[key]
    }
    // trigger / keywords 成对处理：从 keyword 改成别的模式时要把关键词清空，
    // 否则残留的关键词会在下次改回 keyword 时意外复活。
    const trigger = body.trigger !== undefined ? body.trigger : previous.trigger
    merged.trigger = trigger
    if (trigger === 'keyword') {
      merged.keywords = body.keywords !== undefined ? body.keywords : previous.keywords
    } else {
      merged.keywords = []
    }
    // 时段：显式传 null 或空串表示「取消时段限制」，不传表示保持不变。
    if (Object.hasOwn(body, 'windowStart')) merged.windowStart = body.windowStart
    else merged.windowStart = previous.windowStartMinutes === null ? null : formatClock(previous.windowStartMinutes)
    if (Object.hasOwn(body, 'windowEnd')) merged.windowEnd = body.windowEnd
    else merged.windowEnd = previous.windowEndMinutes === null ? null : formatClock(previous.windowEndMinutes)
    // sessionId 必须带回合并结果：validateCreateArgs 要它非空，
    // 而调用方是拿 merged 去校验的 —— 少了它每次编辑都会被判「会话不能为空」。
    // 真正要不要换会话由调用方按 body.sessionId 再决定（见 update 路由）。
    merged.sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
      ? body.sessionId.trim()
      : previous.sessionId
    // wakeText 同理：它是判定规则合法性的必需字段，也必须从旧规则带过来，
    // 否则「只改个名额」这种局部编辑会被判「唤醒文本不能为空」。
    if (merged.wakeText === undefined) merged.wakeText = previous.wakeText
    return merged
  }

  /**
   * 编辑后的规则状态。
   *
   * 熔断（tripped）是终态，但用户主动编辑一条规则就是在表示「我想让它继续」
   * —— 这是唯一合法的解熔断入口，比让人先删再建强。
   *
   * @param {object} previous 旧规则。
   * @param {object} body 编辑请求体。
   * @returns {string} 新状态。
   */
  function bookkeepingForEdit(previous, body) {
    // 显式要求恢复才恢复；单纯改个唤醒文本不该静默解熔断。
    if (previous.status === 'tripped') return body.resume === true ? 'active' : 'tripped'
    if (previous.status === 'paused') return body.resume === true ? 'active' : 'paused'
    return 'active'
  }

  /**
   * 编辑后的下次检查时刻。
   *
   * 间隔改小了应当立刻按新间隔生效，否则用户改了 300→60 还要等 5 分钟才看到效果。
   *
   * @param {object} previous 旧规则。
   * @param {object} body 编辑请求体。
   * @param {object} merged 合并后的配置。
   * @returns {number} 新的 nextCheckAt。
   */
  function nextCheckAfterEdit(previous, body, merged) {
    const now = Date.now()
    const everyMs = clamp(num(merged.everySeconds, previous.everySeconds), MIN_EVERY_SECONDS, MAX_EVERY_SECONDS) * 1000
    if (body.restartSoon === true) return now
    // 间隔被改小了就立刻收紧，否则保持原计划（避免每次编辑都把节拍重置）。
    const planned = previous.nextCheckAt
    if (!Number.isFinite(planned)) return now + everyMs
    const ceiling = now + everyMs
    return planned > ceiling ? ceiling : Math.max(planned, now)
  }

  /**
   * 把 listSessions 的一行摊平成设置页需要的形状。
   *
   * 真实结构是 `{ header: SessionHeader, live, persisted }`，
   * 但不同版本可能多一层或少一层，这里逐层兜底，避免又一次「列表恒空」。
   *
   * @param {object} row listSessions 的一项。
   * @returns {{sessionId: string, title: string, updatedAt: string|null}} 摊平结果。
   */
  function normalizeSessionRow(row) {
    if (!isRecord(row)) return { sessionId: '', title: '', updatedAt: null }
    const header = isRecord(row.header) ? row.header : row
    const id = header.id ?? header.sessionId ?? row.id ?? row.sessionId ?? ''
    const title = typeof header.title === 'string' ? header.title : (typeof row.title === 'string' ? row.title : '')
    // 时间字段各家叫法不一，取到哪个用哪个，都没有就 null（前端显示「—」）。
    const rawTime = header.updatedAt ?? header.lastActivityAt ?? header.createdAt
      ?? row.updatedAt ?? row.lastActivityAt ?? row.createdAt
    let updatedAt = null
    if (typeof rawTime === 'string') updatedAt = rawTime
    else if (typeof rawTime === 'number') updatedAt = new Date(rawTime).toISOString()
    return { sessionId: String(id), title, updatedAt }
  }

  /**
   * 取一批会话的标题（尽力而为，失败返回空表）。
   * @param {object} sessionQuery 查询服务。
   * @param {Array<object>} summaries 会话摘要。
   * @returns {Promise<Map<string, string>>} sessionId → 标题。
   */
  async function loadTitles(sessionQuery, summaries) {
    const map = new Map()
    const ids = summaries
      .map(summary => summary.sessionId)
      .filter(id => typeof id === 'string' && id.startsWith('session-'))
    if (ids.length === 0) return map
    if (typeof sessionQuery.readTitleSnapshots === 'function') {
      try {
        // 真实结构是 projectMany 的包装：{ sessionId, status, value: { session: header, title? } }。
        // 标题在 value.title，不在顶层 —— 顶层只有 sessionId/status/value。
        // （这里吃准了结构才写映射：先打真实样本，再写代码。）
        const snapshots = await sessionQuery.readTitleSnapshots(ids)
        const entries = Array.isArray(snapshots) ? snapshots : []
        for (const entry of entries) {
          if (!isRecord(entry)) continue
          const id = String(entry.sessionId ?? '')
          if (id.length === 0 || entry.status === 'rejected') continue
          const value = isRecord(entry.value) ? entry.value : undefined
          const title = readTitleText(value !== undefined ? value.title : undefined)
          if (title.length > 0) map.set(id, title)
        }
      } catch (error) {
        logger.debug?.(`auto-wake: readTitleSnapshots 失败：${String(error)}`)
      }
    }
    return map
  }

  /**
   * 注册四个模型工具。
   * @param {object} tools tools 服务。
   */
  function registerTools(tools) {
    // 等状态载入，工具操作才不会跟初始化抢。
    const whenReady = () => ready

    tools.register(defineTool({
      name: 'autowake_create',
      description: '给某个会话挂一条自动唤醒规则：宿主按间隔检查它最新一轮是不是「结束得不像结束」（LLM 报错 / 被 max-tokens 截断 / 长时间静默且没待办），或命中关键词时，真正把它叫醒继续干活。参数扁平传入，不包数组。',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: '目标会话 id（可以是当前会话自己）。',
        },
        wakeText: {
          type: 'string',
          required: true,
          description: `唤醒时投递给它的话，${MAX_WAKE_TEXT_LENGTH} 字以内。写清「接着做什么」，不要只写「继续」。`,
        },
        title: {
          type: 'string',
          description: `规则名，便于 autowake_list 里辨认，${MAX_TITLE_LENGTH} 字以内。`,
        },
        trigger: {
          type: 'string',
          enum: TRIGGER_KINDS,
          description: '触发条件：unfinished（默认，检测结束异常）/ keyword（命中关键词）/ always（只要空闲就唤醒）。',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'trigger=keyword 时的关键词列表，命中任意一个即唤醒。',
        },
        everySeconds: {
          type: 'number',
          description: `轮询间隔秒数，${MIN_EVERY_SECONDS}–${MAX_EVERY_SECONDS}，默认 300。`,
        },
        initialDelaySeconds: {
          type: 'number',
          description: '首次检查前先等多少秒，默认等于 everySeconds。',
        },
        mode: {
          type: 'string',
          enum: DELIVERY_MODES,
          description: '投递模式：queue（默认，排队）/ steer（插队）。',
        },
        maxPerHour: {
          type: 'number',
          description: `每小时最多唤醒几次，默认 ${DEFAULT_MAX_PER_HOUR}。`,
        },
        maxPerDay: {
          type: 'number',
          description: `每天最多唤醒几次，默认 ${DEFAULT_MAX_PER_DAY}。`,
        },
        cooldownSeconds: {
          type: 'number',
          description: `两次唤醒之间至少隔多少秒，默认 300。`,
        },
        maxConsecutiveStalls: {
          type: 'number',
          description: `连续多少次唤醒后目标会话仍无进展就熔断，默认 ${DEFAULT_MAX_STALLS}。`,
        },
        silenceMs: {
          type: 'number',
          description: `「长时间静默」的判定毫秒数，默认 ${DEFAULT_SILENCE_MS}。`,
        },
        windowStart: {
          type: 'string',
          description: '北京时间段开始，形如 "09:00"。只在段内才唤醒；省略表示全天可用。',
        },
        windowEnd: {
          type: 'string',
          description: '北京时间段结束，形如 "22:30"。若开始晚于结束则视为跨天（如 "22:00"–"06:00"）。',
        },
        minIdleSeconds: {
          type: 'number',
          description: '目标会话至少静置多少秒后才唤醒（「过了多久自动唤醒」）。默认 0 = 不限制。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                id: { type: 'string', required: true },
                rule: { type: 'object', required: true, additionalProperties: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          ],
        },
        render: renderJson,
      },
      async execute(args) {
        await whenReady()
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return { ok: false, ...invalid }

        // 收到 cs_ 之类的会话别名时先解析成真实 SessionId 再落库，
        // 否则要到投递时才吃 session/not-found，用户还得回头猜哪条错了。
        const resolved = await resolveSessionId(args.sessionId.trim())
        if (resolved.error !== undefined) return { ok: false, ...resolved.error }
        args = { ...args, sessionId: resolved.sessionId }

        const now = Date.now()
        const raw = {
          ...args,
          id: newRuleId(),
          trigger: args.trigger === undefined ? 'unfinished' : args.trigger,
          createdAt: now,
          // initialDelaySeconds 的默认交给 normalizeRule 统一处理，这里不再重复一次。
          nextCheckAt: now + clamp(num(args.initialDelaySeconds, num(args.everySeconds, 300)), 0, MAX_EVERY_SECONDS) * 1000,
          status: 'active',
        }
        const rule = normalizeRule(raw)
        if (rule === undefined) {
          return { ok: false, ...fail('internal_error', '规则构造失败，请检查参数。') }
        }

        state.rules.push(rule)
        dirty = true
        // 落盘失败必须回滚内存并报错，不能「说成功但其实没存」。
        const saved = await persist()
        if (!saved) {
          state.rules = state.rules.filter(candidate => candidate.id !== rule.id)
          return { ok: false, ...fail('persist_failed', `规则未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) }
        }
        requestTick(0)
        return { ok: true, id: rule.id, rule: ruleView(rule, Date.now()) }
      },
    }))

    tools.register(defineTool({
      name: 'autowake_list',
      description: '列出自动唤醒规则及它们当前的额度余额、冷却与熔断状态。',
      parameters: {
        sessionId: {
          type: 'string',
          description: '只看某个会话的规则；省略则列出全部。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                total: { type: 'integer', required: true },
                rules: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          ],
        },
        render: renderJson,
      },
      async execute(args) {
        await whenReady()
        const now = Date.now()
        const filter = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
        const rules = state.rules
          .filter(rule => filter === undefined || rule.sessionId === filter)
          .map(rule => ruleView(rule, now))
        return { ok: true, total: rules.length, rules }
      },
    }))

    tools.register(defineTool({
      name: 'autowake_delete',
      description: '删除一条自动唤醒规则。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'autowake_create 返回或 autowake_list 列出的规则 id。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                id: { type: 'string', required: true },
                deleted: { type: 'boolean', required: true, const: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          ],
        },
        render: renderJson,
      },
      async execute(args) {
        await whenReady()
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) return { ok: false, ...fail('invalid_id', 'id 不能为空。') }

        const index = state.rules.findIndex(rule => rule.id === id)
        if (index < 0) return { ok: false, ...fail('not_found', `找不到规则 ${id}。`) }

        const [removed] = state.rules.splice(index, 1)
        dirty = true
        // 删除同样要确认落盘，否则重启后「已删」的规则会复活。
        const saved = await persist()
        if (!saved) {
          state.rules.splice(index, 0, removed)
          return { ok: false, ...fail('persist_failed', `删除未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) }
        }
        requestTick(0)
        return { ok: true, id, deleted: true }
      },
    }))

    tools.register(defineTool({
      name: 'autowake_update',
      description: '修改一条已有的自动唤醒规则。只传要改的字段；运行时状态（额度余额、熔断计数、进度游标）一律保留。规则被熔断后，用 resume:true 可以恢复。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'autowake_list 列出的规则 id。',
        },
        sessionId: { type: 'string', description: '换一个目标会话；省略表示不改。' },
        wakeText: { type: 'string', description: '新的唤醒文本。' },
        title: { type: 'string', description: '新的规则名。' },
        trigger: {
          type: 'string',
          enum: TRIGGER_KINDS,
          description: '新的触发条件。',
        },
        keywords: {
          type: 'array',
          description: 'trigger=keyword 时的关键词列表。',
          items: { type: 'string' },
        },
        everySeconds: { type: 'number', description: `轮询间隔秒数，${MIN_EVERY_SECONDS}–${MAX_EVERY_SECONDS}。` },
        initialDelaySeconds: { type: 'number', description: '首次检查前的等待秒数。' },
        mode: { type: 'string', enum: DELIVERY_MODES, description: '投递模式。' },
        maxPerHour: { type: 'number', description: '每小时唤醒上限。' },
        maxPerDay: { type: 'number', description: '每天唤醒上限。' },
        cooldownSeconds: { type: 'number', description: '两次唤醒之间的最小间隔秒数。' },
        maxConsecutiveStalls: { type: 'number', description: '连续无进展多少次后熔断。' },
        silenceMs: { type: 'number', description: '「长时间静默」判定毫秒数。' },
        windowStart: { type: 'string', description: '北京时间段开始 "09:00"；传空串取消时段限制。' },
        windowEnd: { type: 'string', description: '北京时间段结束 "22:00"；传空串取消时段限制。' },
        minIdleSeconds: { type: 'number', description: '目标会话至少静置多少秒后才唤醒。' },
        resume: {
          type: 'boolean',
          description: '规则已被熔断或暂停时，传 true 让它恢复运行。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                id: { type: 'string', required: true },
                rule: { type: 'object', required: true, additionalProperties: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          ],
        },
        render: renderJson,
      },
      async execute(args) {
        await whenReady()
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id.length === 0) return { ok: false, ...fail('invalid_id', 'id 不能为空。') }
        const index = state.rules.findIndex(rule => rule.id === id)
        if (index < 0) return { ok: false, ...fail('not_found', `找不到规则 ${id}。`) }

        const previous = state.rules[index]
        const merged = mergeRuleEdit(previous, args)
        const invalid = validateCreateArgs({ ...merged, excludeId: previous.id })
        if (invalid !== undefined) return { ok: false, ...invalid }

        let sessionId = previous.sessionId
        if (typeof args.sessionId === 'string' && args.sessionId.trim().length > 0 && args.sessionId.trim() !== previous.sessionId) {
          const resolved = await resolveSessionId(args.sessionId.trim())
          if (resolved.error !== undefined) return { ok: false, ...resolved.error }
          sessionId = resolved.sessionId
        }

        const next = normalizeRule({
          ...previous,
          ...merged,
          id: previous.id,
          sessionId,
          createdAt: previous.createdAt,
          status: bookkeepingForEdit(previous, args),
          nextCheckAt: nextCheckAfterEdit(previous, args, merged),
          lastKeywordHitSeq: previous.lastKeywordHitSeq,
        })
        if (next === undefined) return { ok: false, ...fail('internal_error', '规则构造失败，请检查参数。') }

        state.rules[index] = next
        dirty = true
        const saved = await persist()
        if (!saved) {
          state.rules[index] = previous
          return { ok: false, ...fail('persist_failed', `修改未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`) }
        }
        requestTick(0)
        return { ok: true, id: next.id, rule: ruleView(next, Date.now()) }
      },
    }))

    tools.register(defineTool({
      name: 'autowake_run',
      description: '立刻按当前规则跑一轮检查，不等下一个自然节拍。返回这轮各规则的判定结果。',
      parameters: {
        id: {
          type: 'string',
          description: '只跑指定规则；省略则跑全部 active 规则。',
        },
        dryRun: {
          type: 'boolean',
          description: '只判定不投递（不真的叫醒对方），用于确认触发条件是否写对了。',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: true },
                checked: { type: 'integer', required: true },
                dryRun: { type: 'boolean', required: true },
                results: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          ],
        },
        render: renderJson,
      },
      async execute(args) {
        await whenReady()
        const id = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : undefined
        const dryRun = args.dryRun === true

        const targets = state.rules.filter(rule => (id === undefined ? rule.status === 'active' : rule.id === id))
        if (id !== undefined && targets.length === 0) {
          return { ok: false, ...fail('not_found', `找不到规则 ${id}。`) }
        }

        const now = Date.now()
        const results = []
        for (const rule of targets.slice(0, MAX_RULES_PER_TICK)) {
          // 复用正常路径的判定，但把 nextCheckAt 临时拉到现在，让它一定被处理。
          if (dryRun) {
            const factsResult = await readSessionFacts(ctx, rule.sessionId)
            if (factsResult.error !== undefined) {
              results.push({ id: rule.id, sessionId: rule.sessionId, fire: false, reason: 'unknown:no_reader' })
              continue
            }
            const facts = { ...inspectEvents(factsResult.events), busy: factsResult.busy === true }
            const verdict = evaluate(rule, facts, now)
            // H-R1：dryRun 传 forDelivery=false，让 in_flight 不挡住排障视图。
            const refusal = verdict.fire ? guardrailRefusal(rule, now, { forDelivery: false }) : undefined
            results.push({
              id: rule.id,
              sessionId: rule.sessionId,
              fire: verdict.fire && refusal === undefined,
              reason: refusal === undefined ? verdict.reason : `skipped:${refusal}`,
              busy: facts.busy,
            })
            continue
          }

          rule.nextCheckAt = now
          await handleRule(rule, now)
          results.push({ id: rule.id, sessionId: rule.sessionId, result: rule.lastResult })
        }

        if (!dryRun) {
          dirty = true
          // 落盘失败要让调用方看见，而不是只留一条 logger.error。
          const saved = await persist()
          requestTick(0)
          if (!saved) {
            return {
              ok: false,
              ...fail('persist_failed', `本轮结果未能写入 ${statePath}：${lastPersistError ?? '未知错误'}`),
            }
          }
        }
        return { ok: true, checked: results.length, dryRun, results }
      },
    }))
  }

  /**
   * 把模型给的 sessionId 解析成真实存在、可直接传给 prompt 的 SessionId。
   *
   * 会话别名（如 `cs_xxxx`）不是 SessionId 本体：直接拿去 prompt 会得到
   * `session/not-found`。这里先用 listSessions 列一遍 header（只读 header，不读日志体），
   * 能按 id 命中就放行；命中不到但形如别名时给出明确指引。
   *
   * @param {string} raw 模型传入的原始 sessionId。
   * @returns {Promise<{sessionId: string}|{error: {code: string, message: string}}>}
   */
  async function resolveSessionId(raw) {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
      // 宿主不可用时不做拦截：宁可让 prompt 自己报错，也不要凭空拒绝合法 id。
      return { sessionId: raw }
    }

    let records
    try {
      records = await sessionQuery.listSessions()
    } catch (error) {
      logger.debug?.(`auto-wake: listSessions 失败，跳过 sessionId 校验：${String(error)}`)
      return { sessionId: raw }
    }

    const ids = Array.isArray(records)
      ? records.map(record => (isRecord(record) && isRecord(record.header) ? record.header.id : undefined)).filter(id => typeof id === 'string')
      : []

    if (ids.includes(raw)) return { sessionId: raw }

    // 形如别名的值单独提示，比只说「找不到」有用得多。
    if (/^cs[_-]/i.test(raw)) {
      return {
        error: fail('session/not_found', `"${raw}" 看起来是会话别名，不是 SessionId。请用 autowake_list 之外的方式确认真实会话 id，或直接传 session-<uuid> 形式。`),
      }
    }
    return { error: fail('session/not_found', `找不到会话 ${raw}。请确认 id 是否正确。`) }
  }

  /** 工具结果的通用渲染：直接给 JSON。 */
  function renderJson(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }

  /**
   * autowake_create 的入参校验。
   * @param {object} args 模型给的参数。
   * @returns {{code: string, message: string}|undefined}
   */
  function validateCreateArgs(args) {
    if (typeof args.sessionId !== 'string' || args.sessionId.trim().length === 0) {
      return fail('invalid_session', 'sessionId 不能为空。')
    }
    if (typeof args.wakeText !== 'string' || args.wakeText.trim().length === 0) {
      return fail('invalid_wake_text', 'wakeText 不能为空。')
    }
    if (args.wakeText.length > MAX_WAKE_TEXT_LENGTH) {
      return fail('invalid_wake_text', `wakeText 超过 ${MAX_WAKE_TEXT_LENGTH} 字。`)
    }
    if (args.title !== undefined && (typeof args.title !== 'string' || args.title.trim().length === 0)) {
      return fail('invalid_title', 'title 给值时必须是非空字符串。')
    }
    if (args.title !== undefined && args.title.length > MAX_TITLE_LENGTH) {
      return fail('invalid_title', `title 超过 ${MAX_TITLE_LENGTH} 字。`)
    }
    if (args.trigger !== undefined && !TRIGGER_KINDS.includes(args.trigger)) {
      return fail('invalid_trigger', `trigger 只能是 ${TRIGGER_KINDS.join(' / ')}。`)
    }
    if (args.trigger === 'keyword') {
      const keywords = Array.isArray(args.keywords)
        ? args.keywords.filter(item => typeof item === 'string' && item.trim().length > 0)
        : []
      if (keywords.length === 0) {
        return fail('invalid_keywords', 'trigger=keyword 时 keywords 至少要有一个非空字符串。')
      }
    }
    if (args.mode !== undefined && !DELIVERY_MODES.includes(args.mode)) {
      return fail('invalid_mode', `mode 只能是 ${DELIVERY_MODES.join(' / ')}。`)
    }
    if (args.everySeconds !== undefined) {
      const every = num(args.everySeconds, Number.NaN)
      if (!Number.isFinite(every) || every < MIN_EVERY_SECONDS || every > MAX_EVERY_SECONDS) {
        return fail('invalid_interval', `everySeconds 必须是 ${MIN_EVERY_SECONDS}–${MAX_EVERY_SECONDS} 之间的数字。`)
      }
    }
    // 同一会话同一份唤醒文本不重复挂，避免手滑造出双份定时唤醒。
    // excludeId 让「编辑自己」不被自己的旧记录撞上 —— 编辑时 args 已经
    // 是合并后的新值，但内存里那条同名规则就是它本身。
    const duplicate = state.rules.some(rule => rule.id !== args.excludeId
      && rule.sessionId === args.sessionId.trim()
      && rule.wakeText === args.wakeText
      && rule.status === 'active')
    if (duplicate) {
      return fail('duplicate_rule', '这个会话已经有一条相同唤醒文本的 active 规则了。')
    }
    return undefined
  }
}

/** 把内部原因码翻译成人话，写进唤醒正文。 */
function describeReason(reason) {
  if (reason.startsWith('keyword:')) return `命中关键词「${reason.slice('keyword:'.length)}」`
  switch (reason) {
    case 'error': return '上一轮以错误结束'
    case 'max-tokens': return '上一轮被 max-tokens 截断'
    case 'turn-open': return '上一轮没有正常闭合（可能中断了）'
    case 'silent': return '长时间没有新动静且没有待办'
    case 'always': return '按规则定时检查'
    default: return reason
  }
}
