import type { NewspaperTheme } from '@/newspaper/Newspaper';

export function parseTheme(value: string | string[] | undefined): NewspaperTheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}
