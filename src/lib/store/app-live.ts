import type { WriteBatch } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { recordConverter } from './converters';
import { paths } from './paths';
import { commitInBatches, getAllInGroups } from './tx';
import type { AppLiveRecord, ConcurrentChartRecord } from './types';

const liveRef = (appid: number) => db.doc(paths.appLive(appid)).withConverter(recordConverter<AppLiveRecord>());
const chartRef = () => db.doc(paths.concurrentChart()).withConverter(recordConverter<ConcurrentChartRecord>());

export async function readAppLive(appids: readonly number[]): Promise<Map<number, AppLiveRecord>> {
  const snapshots = await getAllInGroups(appids.map(liveRef));
  const records = new Map<number, AppLiveRecord>();
  snapshots.forEach((snapshot, index) => {
    const record = snapshot.data() as AppLiveRecord | undefined;
    if (record) records.set(appids[index], record);
  });
  return records;
}

export async function writeAppLive(records: ReadonlyMap<number, AppLiveRecord>): Promise<void> {
  await commitInBatches([...records].map(([appid, record]) => (batch: WriteBatch) => { batch.set(liveRef(appid), record); }));
}

export async function readConcurrentChart(): Promise<ConcurrentChartRecord | undefined> {
  return (await chartRef().get()).data();
}

export async function writeConcurrentChart(record: ConcurrentChartRecord): Promise<void> {
  await chartRef().set(record);
}
