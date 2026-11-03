/**
 * 前端常量：口味 / 价格档位 / 快捷短语 / 场景入口 / 欢迎语 / localStorage key / 皮肤。
 *
 * 从 `app/page.tsx` 搬出来。这里有几条**跟后端强耦合**的约定，改的时候别只改一边：
 *   - `BUDGETS` 必须与 `lib/llm/local-workflow.ts` 的 `BUDGET_MAP`、
 *     `lib/prompts/system-prompt.ts` 的价格档位文案、`lib/llm/index.ts` 的 `CHEAP_PATTERN` 一致；
 *   - `PROFILE_TRUSTED_KEYS` 必须与 `lib/chat/handlers.ts` 的同一份白名单一致；
 *   - `THEME_KEY` 必须与 `app/layout.tsx` 里防闪烁的内联脚本一致。
 */

export const FLAVORS = [
  { label: '辣味', icon: '🌶️' },
  { label: '甜味', icon: '🍬' },
  { label: '咸味', icon: '🧂' },
  { label: '酸味', icon: '🍋' },
  { label: '清淡', icon: '🥯' },
  { label: '坚果', icon: '🥜' },
  { label: '嚼感解压', icon: '🦾' },
];

export const BUDGETS = [
  { label: '30元内', icon: '💰' },
  { label: '30-60元', icon: '💎' },
  { label: '60元以上', icon: '👑' },
];

/** 聊起来后的快捷开口：给场景，不给"来点甜的"这种跟卡片按钮重复的话 */
export const QUICK = [
  { label: '追剧来点', icon: '🎬', text: '追剧的时候来点吃的' },
  { label: '去海边带点', icon: '🌊', text: '明天去看海，带点吃的' },
  { label: '加班垫垫', icon: '💻', text: '加班熬夜，来点垫肚子的' },
  { label: '换一批', icon: '🔄', text: '换一批' },
];

/** 空会话时的场景入口：给个具体的开口方式，别让人对着空白框发呆 */
export const SCENES = [
  {
    icon: '🎬',
    title: '追剧解馋',
    sub: '看点剧，嘴别闲着',
    text: '追剧的时候来点吃的',
  },
  {
    icon: '🌊',
    title: '出去玩带点',
    sub: '海边爬山能扛饿的',
    text: '明天去看海，带点吃的',
  },
  {
    icon: '😮‍💨',
    title: '烦了想发泄',
    sub: '不想说话也行',
    text: '今天被领导当众骂了，烦死',
  },
];

export const WELCOME = '嘿，我是脆脆 🥜\n馋了直接说，想找人说话也行。\n对了——今天咋样？';

/** 聊天记录 + 左侧偏好存本地，刷新页面不丢 */
export const STORE_KEY = 'cx_chat_v1';
/** 从对话里攒出来的偏好（忌口/口味/场景），跨会话记住"不吃辣"这类长期约定 */
export const PROFILE_KEY = 'cx_profile_v1';
/** 历史脏数据作废标记：置上之后就不再清空 PROFILE_KEY（见初始化时的迁移） */
export const PROFILE_RESET_KEY = 'cx_profile_reset_20261102';
/** 点过「想要」的零食清单 */
export const WANT_KEY = 'cx_want_v1';
/** 长期记忆的用户标识：第一次进站生成一个固定住，后端据此存/取记忆，不然所有人的记忆会串在一个桶里 */
export const USER_KEY = 'cx_user_v1';
/** 皮肤偏好：跟 layout.tsx 里防闪烁的内联脚本用同一个 key，改一处必须改两处 */
export const THEME_KEY = 'cx_theme_v1';

/**
 * 皮肤清单。真正决定配色的是 globals.css 里同名的 [data-theme] 变量块，
 * 这里只管按钮上的名字和一个示意色点。
 */
export const THEMES = [
  { key: 'warm', label: '暖阳棕', dot: '#FFB84D' },
  { key: 'obsidian', label: '曜石黑', dot: '#3A332E' },
  { key: 'glacier', label: '冰川蓝', dot: '#5AA9E6' },
] as const;

export type ThemeKey = (typeof THEMES)[number]['key'];

/**
 * 长期偏好里**可信**的 key：口味 / 预算 / 忌口 / 口感。
 *
 * 场景和情绪不在这份里——它们是**当轮语境**（"办公室""看海""烦"），
 * 只在说话那一轮成立。攒进 profile 就是脏数据：跨会话复活，
 * 侧栏一直挂着用户三天前随口提的一句，选品时还会冒充"用户这轮提的约束"。
 * 后端的 `TRUSTED_PROFILE_KEYS`（lib/chat/handlers.ts）是同一份口径。
 */
export const PROFILE_TRUSTED_KEYS = ['flavor', 'budget', 'avoid', 'texture'] as const;

/**
 * 预算只认侧栏那几档（与 `BUDGETS` 同源）。
 *
 * 「不限」不是偏好，是**没提**：模型早年的 schema 里允许填它，
 * 于是用户一句「有什么好吃的」就被记成「预算·不限」挂在侧栏——
 * 用户从没说过这话，怎么点都摘不掉（2026-11-02 的真事）。
 * 「5块」这类自造档同理：选品引擎认不出来，挂上去就是"说了不算"。
 */
export const BUDGET_LABELS = BUDGETS.map((b) => b.label);

/** 偏好 key → 人话标签，给「当前偏好」区显示用（只有可信字段会走到这里） */
export const PROFILE_LABEL: Record<string, string> = {
  avoid: '忌口',
  flavor: '口味',
  texture: '口感',
  budget: '预算',
};
