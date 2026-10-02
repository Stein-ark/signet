import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Stand-in for the next/headers cookie store, with one jar per simulated browser.
 *
 * The active browser is tracked with AsyncLocalStorage rather than a global, so requests from
 * different people can run concurrently without reading each other's cookies.
 */
const browsers = new Map<string, Map<string, string>>();
const active = new AsyncLocalStorage<string>();

function store(): Map<string, string> {
  const browser = active.getStore() ?? 'owner';
  if (!browsers.has(browser)) browsers.set(browser, new Map());
  return browsers.get(browser)!;
}

export const jar = {
  get: (name: string) => (store().has(name) ? { name, value: store().get(name)! } : undefined),
  set: (name: string, value: string) => void store().set(name, value),
  delete: (name: string) => void store().delete(name),
};

/** Run requests in a given person's browser. Requests outside `as` use the owner's browser. */
export function as<T>(browser: string, action: () => Promise<T>): Promise<T> {
  return active.run(browser, action);
}
