// The counted firebase/firestore a test build swaps in (./read-meter-browser, the preset's
// `readMeter`), against the Firestore emulator (`bun run test:emulator`): an app importing it reads
// as before, and window.__hhReads tallies what Firestore bills. Its own process: it loads the real SDK.
import { afterAll, describe, expect, test } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import * as counted from '../../src/read-meter-browser';
import type { PageReadMeter } from '../../src/read-meter-browser';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const meter = () => (globalThis as { __hhReads?: PageReadMeter }).__hhReads!;

describe.skipIf(!emulator)('the counted firebase/firestore', () => {
  const app = initializeApp({ apiKey: 'demo', projectId: 'demo-kit-reads', appId: 'demo' }, 'read-meter-browser');
  const db = counted.initializeFirestore(app, { localCache: counted.memoryLocalCache() });
  const [host, port] = (emulator ?? '127.0.0.1:8080').split(':');
  counted.connectFirestoreEmulator(db, host, Number(port));
  afterAll(async () => {
    await counted.terminate(db);
    await deleteApp(app);
  });

  test('reads as before, and the page tally counts them as billed', async () => {
    const run = `m${Date.now().toString(36)}`;
    for (const id of ['a', 'b', 'c']) await counted.setDoc(counted.doc(db, `runs/${run}/items/${id}`), { n: 1 });
    meter().reset();
    const snap = await counted.getDocs(counted.collection(db, `runs/${run}/items`));
    expect(snap.size).toBe(3);
    await counted.getDocs(counted.collection(db, `runs/${run}/none`));
    const seen = await new Promise<number>((resolve) => {
      const stop = counted.onSnapshot(counted.doc(db, `runs/${run}/items/a`), (d) => {
        stop();
        resolve(d.exists() ? 1 : 0);
      });
    });
    expect(seen).toBe(1);
    expect(meter().tally()).toEqual({ reads: 5, requests: 3, byKind: { query: { requests: 2, reads: 4 }, listen: { requests: 1, reads: 1 } } });
    meter().reset();
    expect(meter().tally().reads).toBe(0);
  });
});
