import { NextResponse } from 'next/server';
import { getPublicLibraryResponse } from '../../../../../lib/steam';

function clientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

export async function GET(request: Request, { params }: { params: Promise<{ steamid: string }> }) {
  try {
    const { steamid } = await params;
    const result = await getPublicLibraryResponse(steamid, clientIp(request));
    const headers: Record<string, string> = 'retryAfter' in result ? { 'Retry-After': String(result.retryAfter) } : {};
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch (error) {
    console.error('Public library lookup failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Unable to reach Steam right now.' }, { status: 502 });
  }
}
