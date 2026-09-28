const DEFAULT_TRUSTED_PROXY_HOPS = 2;

function trustedProxyHops(): number {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isSafeInteger(hops) && hops > 0 ? hops : DEFAULT_TRUSTED_PROXY_HOPS;
}

export function clientIpFromForwardedFor(headers: Headers): string {
  const entries = headers.get('x-forwarded-for')?.split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
  if (entries.length) return entries[Math.max(entries.length - trustedProxyHops(), 0)];
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
