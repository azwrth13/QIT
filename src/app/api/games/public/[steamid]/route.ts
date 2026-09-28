import { NextResponse } from 'next/server';
import { getPublicLibraryResponse, logServerError } from '../../../../../lib/steam';
import { clientIpFromForwardedFor } from '../../../../../lib/client-ip';

export async function GET(request: Request, { params }: { params: Promise<{ steamid: string }> }) {
  try {
    const { steamid } = await params;
    const result = await getPublicLibraryResponse(steamid, clientIpFromForwardedFor(request.headers));
    const headers: Record<string, string> = 'retryAfter' in result ? { 'Retry-After': String(result.retryAfter) } : {};
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch (error) {
    logServerError('Public library lookup failed', error);
    return NextResponse.json({ error: 'Unable to reach Steam right now.' }, { status: 502 });
  }
}
