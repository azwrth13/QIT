export function getBaseUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_BASE_URL is required');
  return new URL(req.url).origin;
}
