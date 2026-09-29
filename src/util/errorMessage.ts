/** Native commands reject with strings, while browser and parser failures usually use Error. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
    try { const json = JSON.stringify(error); if (json && json !== '{}') return json; } catch { /* Fall through. */ }
  }
  return 'An unknown error occurred. Please try again.';
}
