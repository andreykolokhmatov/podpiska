/** Example chips append to whatever is typed: «экономика» + «Без спорта» → «экономика, без спорта». */
export function appendInterest(current: string, example: string): string {
  const base = current.trimEnd();
  if (base === '') return example;
  const lowered = example.charAt(0).toLowerCase() + example.slice(1);
  if (base.toLowerCase().includes(lowered.toLowerCase())) return current;
  const sep = /[.,;:!?]$/.test(base) ? ' ' : ', ';
  return `${base}${sep}${lowered}`;
}
