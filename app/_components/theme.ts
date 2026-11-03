import { THEME_KEY, THEMES, type ThemeKey } from './constants';

/** 落皮肤：变量挂在 <html> 上，body 和各面板才跟着变 */
export function applyTheme(key: ThemeKey) {
  try {
    document.documentElement.dataset.theme = key;
    localStorage.setItem(THEME_KEY, key);
  } catch {
    document.documentElement.dataset.theme = key;
  }
}

/** 读上次的皮肤，存坏了或存了不认识的就退回暖阳棕 */
export function readTheme(): ThemeKey {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.some((t) => t.key === saved)) return saved as ThemeKey;
  } catch {
    /* 隐私模式读不了，走默认值 */
  }
  return 'warm';
}
