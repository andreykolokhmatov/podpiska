/**
 * Set once any /api/app call answers 403 private_instance: the whole app is closed to this user,
 * so the shell swaps every screen for the private-instance placeholder. Never reset – the answer
 * depends only on the user and the instance's env.
 */
let isPrivate = false;
const listeners = new Set<() => void>();

export const privateInstanceStore = {
  get: (): boolean => isPrivate,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  mark(): void {
    if (isPrivate) return;
    isPrivate = true;
    for (const listener of listeners) listener();
  },
};
