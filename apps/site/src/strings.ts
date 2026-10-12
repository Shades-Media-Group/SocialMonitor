/** The translated strings pages.ts put in the page for its scripts. */
export function strings<T>(): T {
  return JSON.parse(document.getElementById('strings')?.textContent ?? '{}') as T
}
