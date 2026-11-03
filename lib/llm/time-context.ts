// lib/llm/time-context.ts
//
// 当下时间。给提示词（语气别穿帮）和选品（深夜款别在上午推出去）共用。
//
// 为什么需要：大模型和系统都没有"现在几点"这个概念。白天给用户推了
// scenes 里带「深夜」的那款，商品理由原文复述出来就是"深夜也不腻"——
// 用户读着像对面坐了个不看表的人。

export type TimePeriod = '凌晨' | '早上' | '上午' | '中午' | '下午' | '晚上' | '深夜'

/**
 * 深夜段：23 点以后到凌晨 5 点前。
 *
 * 以前从 21 点就开始算"深夜"——实测晚上 21:13 被判成深夜，提示词里那句
 * "这个点还没睡"直接喂给模型，它转头就问用户"今晚怎么还没睡"，
 * 用户当场纠正"才九点多"。21–23 点是**晚上**，人精神着呢，不是夜宵时段。
 */
const NIGHT_START = 23
const NIGHT_END = 5

export interface TimeContext {
  hour: number
  period: TimePeriod
  /** 中文周几，给提示词用 */
  weekday: string
  /** 是不是"该推夜宵"的时段 */
  isNight: boolean
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function periodOf(hour: number): TimePeriod {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 18) return '下午'
  if (hour < NIGHT_START) return '晚上'
  return '深夜'
}

export function timeContext(now: Date = new Date()): TimeContext {
  const hour = now.getHours()
  return {
    hour,
    period: periodOf(hour),
    weekday: WEEKDAYS[now.getDay()],
    isNight: hour >= NIGHT_START || hour < NIGHT_END,
  }
}

/**
 * 提示词用的时间段落。写得像顺口提一句，不带"数据透出"的腔。
 * 空段落比废话强——但时间每次都给，因为"深夜续命"这种穿帮成本太高。
 */
export function timeSection(now: Date = new Date()): string {
  const { hour, period, weekday, isNight } = timeContext(now)
  // 晚上（21–23 点）是最容易穿帮的一段：人还没睡，却被当成熬夜党。
  // 所以这一段单独把"别问怎么还没睡"写死，光给个时段名挡不住模型脑补
  const nightHint = isNight
    ? '这个点还没睡，说话慢点、别打鸡血，别劝人早睡（说了等于没说）。真要推零食，优先扛饿、不齁的'
    : period === '晚上'
      ? `才${hour}点多，属于正常活动时间——别问"怎么还没睡"，也别提"深夜""熬夜""通宵"`
      : '现在是白天，别提"深夜""熬夜""通宵"这类词——用户是在白天跟你说话'

  return `

# 十、当下时间

现在是${weekday}${period}，${hour}点左右。

${nightHint}。推荐零食时贴合这个时段（上午提神、下午垫肚子、夜里别推太刺激的）。`
}
