// `firebase/firestore` with its reads counted, for test builds of an app (the kit's Vite preset
// swaps it in with VITE_USE_EMULATORS=true or VITE_READ_METER=true; `readMeter` in ./vite). Every
// app's and the kit's own reads then go through the counter (./read-test `readCounter().sdk`), and
// `window.__hhReads` gives a browser test the page's tally (./e2e `expectPageReads`). Never in a
// production build.
import * as real from 'firebase/firestore';
import { PAGE_READS_KEY, readCounter, type PageReadMeter, type ReadTally } from './read-test.js';

const counter = readCounter();
const counted = counter.sdk(real);

export * from 'firebase/firestore';
export const getDoc = counted.getDoc as typeof real.getDoc;
export const getDocFromServer = counted.getDocFromServer as typeof real.getDocFromServer;
export const getDocs = counted.getDocs as typeof real.getDocs;
export const getDocsFromServer = counted.getDocsFromServer as typeof real.getDocsFromServer;
export const getCountFromServer = counted.getCountFromServer as typeof real.getCountFromServer;
export const getAggregateFromServer = counted.getAggregateFromServer as typeof real.getAggregateFromServer;
export const onSnapshot = counted.onSnapshot as typeof real.onSnapshot;

export type { PageReadMeter };

(globalThis as unknown as Record<string, PageReadMeter>)[PAGE_READS_KEY] = {
  tally: () => JSON.parse(JSON.stringify(counter.tally)) as ReadTally,
  reset: () => counter.reset(),
};
