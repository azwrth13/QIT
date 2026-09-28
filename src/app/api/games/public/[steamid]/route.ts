import { NextResponse } from 'next/server';
import { getPublicLibrary } from '../../../../../lib/steam';

export async function GET(_request: Request, { params }: { params: Promise<{ steamid: string }> }) {
  try {
    const { steamid } = await params;
    const library = await getPublicLibrary(steamid);
    return NextResponse.json(library, { status: library.state === 'unknown' ? 404 : 200 });
  } catch (error) {
    console.error('Public library lookup failed:', error);
    return NextResponse.json({ error: 'Unable to reach Steam right now.' }, { status: 502 });
  }
}
