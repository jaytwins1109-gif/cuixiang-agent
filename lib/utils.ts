// lib/utils.ts — shadcn 风格的类名合并（clsx + tailwind-merge）
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
