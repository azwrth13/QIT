import { deflateSync, inflateSync } from 'node:zlib';
import type { Candidate } from '../roulette/types';
import { LobbyError } from './model';

const MAX_CHUNK_BYTES = 700_000;
const PREFIX = 'deflate-v1:';

/** Bounded, compressed JSON strings avoid indexing thousands of nested game/member fields. */
export function encodeCommon(candidates: Candidate[]): string[] {
  const chunks: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  const flush = () => { chunks.push(PREFIX + deflateSync(`[${rows.join(',')}]`).toString('base64')); rows = []; bytes = 2; };
  for (const candidate of candidates) {
    const row = JSON.stringify(candidate);
    const size = Buffer.byteLength(row) + 1;
    if (size + 2 > MAX_CHUNK_BYTES) throw new LobbyError('too_large', 'Common library is too large.', 413);
    if (bytes + size > MAX_CHUNK_BYTES) flush();
    rows.push(row); bytes += size;
  }
  if (rows.length) flush();
  // Replacing both the old and new set must fit a transaction's request and write limits.
  if (chunks.length > 200 || chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0) > 4_000_000) {
    throw new LobbyError('too_large', 'Common library is too large.', 413);
  }
  return chunks;
}

/** Cache format shared with the later lobby scope; decompression is bounded by the writer's chunk size. */
export function decodeCommonChunk(games: string): Candidate[] {
  if (!games.startsWith(PREFIX)) throw new Error('Unknown lobby cache encoding');
  const json = inflateSync(Buffer.from(games.slice(PREFIX.length), 'base64'), { maxOutputLength: MAX_CHUNK_BYTES });
  return JSON.parse(json.toString('utf8')) as Candidate[];
}
