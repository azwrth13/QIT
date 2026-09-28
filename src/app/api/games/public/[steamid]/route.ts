import { NextResponse } from 'next/server';
import { clientIpFromForwardedFor, getPublicLibraryResponse } from '../../../../../lib/steam';

export async function GET(request: Request, { params }: { params: Promise<{ steamid: string }> }) {
  try {
    const { steamid } = await params;
    const result = await getPublicLibraryResponse(steamid, clientIpFromForwardedFor(request.headers.get('x-forwarded-for')));
    const headers: Record<string, string> = 'retryAfter' in result ? { 'Retry-After': String(result.retryAfter) } : {};
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch (error) {
    console.error('Public library lookup failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Unable to reach Steam right now.' }, { status: 502 });
  }
}
