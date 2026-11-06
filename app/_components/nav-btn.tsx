'use client';

/** 顶栏按钮：统一 40px 触摸目标 + 不换行（360 窄屏下会被挤成竖排） */
export function NavBtn({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /**
   * 按钮里没有可见文字时（窄屏图标模式）**必填**。
   * 没有它的话，读屏软件只能念出一个 emoji，键盘用户也完全没有提示。
   */
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      // whitespace-nowrap：360px 窄屏下顶栏会挤压 nav，不锁住的话
      // 「+ 新对话」会被压成竖排三个字（实测 92px 高），比触摸目标太小更难看
      className="inline-flex min-h-[40px] items-center justify-center whitespace-nowrap rounded-full px-2.5 py-1.5 text-slate-600 transition hover:bg-slate-100 sm:px-3"
    >
      {children}
    </button>
  );
}
