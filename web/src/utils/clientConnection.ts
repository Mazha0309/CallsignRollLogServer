export function clientConnectionUrl(client: string, server: string): string | null {
  try {
    const target = new URL(client);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) return null;
    target.searchParams.set('page', 'settings');
    target.searchParams.set('server', new URL(server).origin);
    return target.href;
  } catch { return null; }
}
