import { beforeEach, describe, expect, test } from 'bun:test';
import fixtures from './fixtures/card-alerts.json';
import readings from './fixtures/alert-readings.json';
import { encodeBase64Url, toMailMessage, type GmailApiMessage, type Mailbox, type MailMessage } from '../src/mail-core';
import {
  alertId, alertQuery, stableHash, categorise, checkAlerts, dayOf, DEFAULT_RULES, identifyCard, matchesRule, merchantProblem, merchantWords, NothingToSearch, parseAlertEmail, readAlert, writtenDay, planAlerts, planImport, ruleCategory,
  sameTransaction, similarDescriptions, statementIds, toAlertInbox, transactionDoc, type AlertCard, type Existing, type ParsedAlert,
} from '../src/spending-core';

// Spending's core, shared by the app and the calendar Worker's mail checker. All cards, senders and
// shops are invented.


describe('categorise', () => {
  test('default rules cover the usual kinds of shop', () => {
    expect(categorise('EXAMPLE COFFEE CO', DEFAULT_RULES)).toBe('Dining & Food');
    expect(categorise('SUPERMARKET 0042', DEFAULT_RULES)).toBe('Groceries');
    expect(categorise('EXAMPLE PHARMACY #12', DEFAULT_RULES)).toBe('Health & Personal Care');
  });

  test('the longest matching phrase wins', () => {
    expect(categorise('AMAZON WEB SERVICES', DEFAULT_RULES)).toBe('Subscriptions & Tech');
    expect(categorise('AMAZON.COM*EXAMPLE', DEFAULT_RULES)).toBe('Shopping & Retail');
  });

  test("the household's own rule beats a shorter default", () => {
    const rules = [...DEFAULT_RULES, { contains: 'example cafe', category: 'Groceries' }];
    expect(categorise('EXAMPLE CAFE #3', rules)).toBe('Groceries');
    expect(categorise('OTHER CAFE', rules)).toBe('Dining & Food');
  });

  test('on a tie the later rule wins', () => {
    expect(ruleCategory('EXAMPLE THING', [{ contains: 'thing', category: 'A' }, { contains: 'thing', category: 'B' }])).toBe('B');
  });

  test("no rule: the bank's category in the dashboard's words, else Miscellaneous", () => {
    expect(categorise('EXAMPLE 123', [], 'Food & Drink')).toBe('Dining & Food');
    expect(categorise('EXAMPLE 123', [])).toBe('Miscellaneous');
  });

  test('phrases match from the start of a word, any case', () => {
    expect(matchesRule('LAS VEGAS SOUVENIRS', 'gas')).toBe(false);
    expect(matchesRule('EXAMPLE GAS STATION', 'GAS')).toBe(true);
    expect(matchesRule('EXAMPLE VETERINARY', 'veterinar')).toBe(true);
  });
});


const statement: Existing = { id: 'st-1', date: '2031-03-10', description: 'BOOKSHOP #12', amount: 42.42, card: 'Card Three', source: 'statement' };
const alert: Existing = { id: 'al-1', date: '2031-03-12', description: 'BOOKSHOP', amount: 42.42, card: 'Card Three', source: 'alert' };

// Shop names without the EXAMPLE prefix here: a shared word is what makes two descriptions alike.
describe("the Apps Script's rule (card, amount, 3 days) plus alike descriptions", () => {
  test('an alert within the window of a statement row on the same card is the same', () => {
    expect(sameTransaction({ date: '2031-03-12', description: 'BOOKSHOP', amount: 42.42, card: 'Card Three' }, statement)).toBe(true);
  });

  test('outside the window, on another card, or another amount it is not', () => {
    expect(sameTransaction({ ...alert, date: '2031-03-15' }, statement)).toBe(false);
    expect(sameTransaction({ ...alert, card: 'Card One' }, statement)).toBe(false);
    expect(sameTransaction({ ...alert, amount: 42.43 }, statement)).toBe(false);
  });

  test('a different shop charging the same amount is a different purchase', () => {
    expect(sameTransaction({ ...alert, description: 'NOODLE BAR' }, statement)).toBe(false);
  });

  test('alike: a shared word, a longer form, or an alert that named no shop', () => {
    expect(similarDescriptions('AMAZON MKTPLACE PMTS', 'AMAZON MKTPL*AB12CD')).toBe(true);
    expect(similarDescriptions('EXAMPLE BOOKSHOPS', 'BOOKSHOP 42')).toBe(true);
    expect(similarDescriptions('Card Purchase', 'EXAMPLE GARAGE')).toBe(true);
    expect(similarDescriptions('EXAMPLE* SUBSCRIPTION', 'EXAMPLE GARAGE')).toBe(true);
    expect(similarDescriptions('NOODLE BAR', 'GARAGE')).toBe(false);
  });
});

describe('planImport', () => {
  test('alerts already recorded are skipped; new ones are created; repeats in one batch count once', () => {
    const fresh = { date: '2031-03-13', description: 'EXAMPLE GARAGE', amount: 9, card: 'Card One' };
    const plan = planImport([{ ...alert, id: 'al-2' }, fresh, { ...fresh, date: '2031-03-14' }], [statement], 'alert');
    expect(plan.duplicates).toBe(2);
    expect(plan.create).toEqual([fresh]);
  });

  test('a statement row replaces the alert for the same purchase', () => {
    const row = { date: '2031-03-10', description: 'BOOKSHOP #12', amount: 42.42, card: 'Card Three' };
    const plan = planImport([row], [alert], 'statement');
    expect(plan.replace).toEqual([{ id: 'al-1', tx: row }]);
    expect(plan.create).toEqual([]);
  });

  test('statement rows already imported are skipped only on an exact match', () => {
    const same = { date: '2031-03-10', description: 'BOOKSHOP #12', amount: 42.42, card: 'Card Three' };
    const nextDay = { ...same, date: '2031-03-11' };
    const plan = planImport([same, nextDay], [statement], 'statement');
    expect(plan.duplicates).toBe(1);
    expect(plan.create).toEqual([nextDay]);
  });

  test('two identical charges in a file against one already saved adds the second', () => {
    const same = { date: '2031-03-10', description: 'BOOKSHOP #12', amount: 42.42, card: 'Card Three' };
    const plan = planImport([same, same], [statement], 'statement');
    expect(plan.duplicates).toBe(1);
    expect(plan.create).toHaveLength(1);
  });
});

describe('ids', () => {
  test('stableHash is the Apps Script mirror hash', () => {
    // Same function, same answer as apps-script/Firestore.gs (pinned in Firestore.test.ts too).
    expect(stableHash('2031-03-10|EXAMPLE|1.00|Card One')).toBe(stableHash('2031-03-10|EXAMPLE|1.00|Card One'));
    expect(stableHash('a')).not.toBe(stableHash('b'));
  });

  test('statement ids are stable, prefixed and numbered for identical rows', () => {
    const row = { date: '2031-03-10', description: 'EXAMPLE', amount: 1, card: 'Card One' };
    const [a, b] = statementIds([row, row]);
    expect(a).toMatch(/^st-[0-9a-z]+$/);
    expect(b).toBe(`${a}-1`);
    expect(statementIds([row])[0]).toBe(a);
  });

  test('one alert document per email', () => {
    expect(alertId('18f0c0ffee')).toBe('al-18f0c0ffee');
  });
});


// Invented cards: two share a sender, one has a sender of its own and a product word.
const cards: AlertCard[] = [
  { name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'] },
  { name: 'Card Two', last4: '2222', alertWords: ['alerts@bank.example.com', 'alerts@cardtwo.example.com', 'blue'] },
  { name: 'Card Three', last4: '3333', alertWords: [] },
];
const sent = new Date(2031, 2, 14, 12).getTime();

describe('parseAlertEmail', () => {
  for (const f of fixtures) {
    test(f.name, () => {
      const got: unknown = parseAlertEmail({ id: 'm1', date: sent, subject: f.email.subject, from: f.email.from, text: f.email.text, html: f.email.html }, cards, DEFAULT_RULES);
      expect(got).toEqual(f.expected === null ? null : { date: '2031-03-14', ...f.expected });
    });
  }
});

describe('alertQuery', () => {
  test('senders search From, other words are phrases, labels are labels; each once', () => {
    expect(alertQuery(cards, ['Bank/Card alerts'])).toBe(
      'newer_than:30d (from:(alerts@bank.example.com) OR from:(alerts@cardtwo.example.com) OR "blue" OR label:bank-card-alerts)',
    );
  });

  test('nothing to search for without alert words or labels', () => {
    expect(alertQuery([{ name: 'Card One', alertWords: [' '] }])).toBeNull();
  });

  test('characters that would change the search are removed', () => {
    expect(alertQuery([{ name: 'Card One', alertWords: ['"purchase" (alert)'] }], [], 7)).toBe('newer_than:7d ("purchase alert")');
  });
});

describe('identifyCard', () => {
  test('digits in the usual wordings', () => {
    for (const text of ['card ending in 3333', 'Card ends in 3333', 'Visa (...3333)', 'XXXX3333', 'used on Card 3333']) {
      expect(identifyCard(text, cards).card).toBe('Card Three');
    }
  });

  test('a product word only one card lists, as a whole word', () => {
    expect(identifyCard('your Blue card', cards).card).toBe('Card Two');
    expect(identifyCard('your bluebird card', cards).card).toBe('Unknown Card');
  });
});


const syncDay = (d: number) => new Date(2031, 2, d, 9).getTime();
const messages: MailMessage[] = [
  { id: 'm3', date: syncDay(14), from: 'alerts@bank.example.com', subject: 'Transaction alert', text: 'You made a $23.40 transaction with NOODLE BAR on your card ending in 2222' },
  { id: 'm2', date: syncDay(13), from: 'alerts@bank.example.com', subject: 'Payment', text: 'We received your payment of $100.00' },
  { id: 'm1', date: syncDay(12), from: 'alerts@bank.example.com', subject: 'Transaction alert', text: 'You made a $42.42 transaction with BOOKSHOP on your card ending in 1111' },
  { id: 'm0', date: syncDay(11), from: 'alerts@bank.example.com', subject: 'Transaction alert', text: 'You made a $5.00 transaction with KIOSK on your card ending in 1111' },
];
const searches: string[] = [];
const reads: string[] = [];
const mailbox: Pick<Mailbox, 'search' | 'get'> = {
  async search(q) {
    searches.push(q);
    return messages.map((m) => m.id);
  },
  async get(id) {
    reads.push(id);
    return messages.find((m) => m.id === id)!;
  },
};
// What the stand-in mailbox was asked, from each test's start.
beforeEach(() => {
  searches.length = 0;
  reads.length = 0;
});
const syncCards = [
  { name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'] },
  { name: 'Card Two', last4: '2222', alertWords: ['alerts@bank.example.com'] },
];

test('reads unseen alerts, skips payments and purchases already recorded', async () => {
  const existing = [
    // The statement row for the bookshop purchase, two days before the alert.
    { id: 'st-x', date: '2031-03-10', description: 'BOOKSHOP #12', amount: 42.42, card: 'Card One', source: 'statement' },
    // The kiosk alert another member's check already wrote.
    { id: 'al-m0', date: '2031-03-11', description: 'KIOSK', amount: 5, card: 'Card One', source: 'alert' },
  ];
  const result = await checkAlerts(mailbox, { cards: syncCards, labels: [], rules: DEFAULT_RULES, existing });
  expect(searches).toEqual(['newer_than:30d (from:(alerts@bank.example.com))']);
  expect(reads.sort()).toEqual(['m1', 'm2', 'm3']);
  expect(result.found).toBe(4);
  expect(result.notPurchases).toBe(1);
  expect(result.duplicates).toBe(1);
  expect(result.create).toEqual([
    { id: 'al-m3', emailId: 'm3', date: '2031-03-14', description: 'NOODLE BAR', amount: 23.4, category: 'Miscellaneous', card: 'Card Two', type: 'Sale', last4: '2222' },
  ]);
  expect(result.read.sort()).toEqual(['m1', 'm2', 'm3']);
});

test('emails read in an earlier check are not read again', async () => {
  await checkAlerts(mailbox, { cards: syncCards, labels: [], rules: [], existing: [], seen: new Set(['m0', 'm1', 'm2']) });
  expect(reads).toEqual(['m3']);
});

test('nothing to search for is said in words', async () => {
  expect(checkAlerts(mailbox, { cards: [{ name: 'Card One', alertWords: [] }], labels: [], rules: [], existing: [] })).rejects.toBeInstanceOf(NothingToSearch);
});

describe('additions for the mail checker', () => {
  const card1: AlertCard[] = [{ name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'] }];

  test('alertQuery after a moment searches by the second', () => {
    expect(alertQuery(card1, [], { after: Date.UTC(2031, 2, 14, 12) })).toBe(`after:${Date.UTC(2031, 2, 14, 12) / 1000} (from:(alerts@bank.example.com))`);
  });

  test("an alert's date is the household's day, not the server's", () => {
    // 02:30 UTC on 15 March is still the 14th in New York and already the 15th in Amsterdam.
    const at = Date.UTC(2031, 2, 15, 2, 30);
    expect(dayOf(at, 'America/New_York')).toBe('2031-03-14');
    expect(dayOf(at, 'Europe/Amsterdam')).toBe('2031-03-15');
    expect(dayOf(at, 'Not/AZone')).toBe(dayOf(at));
    const msg: MailMessage = { id: 'm9', date: at, from: 'alerts@bank.example.com', subject: 'Alert', text: 'You made a $9.99 transaction with EXAMPLE KIOSK on your card ending in 1111' };
    expect(parseAlertEmail(msg, card1, [], { timeZone: 'America/New_York' })?.date).toBe('2031-03-14');
  });

  // Parity: every fixture as Gmail's API returns it (base64url parts, internalDate), through
  // toMailMessage, parses exactly as the MailMessage the browser builds.
  test('the Gmail API form of every fixture parses as the MailMessage form', () => {
    const cards: AlertCard[] = [
      { name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'] },
      { name: 'Card Two', last4: '2222', alertWords: ['alerts@bank.example.com', 'alerts@cardtwo.example.com', 'blue'] },
    ];
    const at = Date.UTC(2031, 2, 14, 17);
    for (const [i, f] of fixtures.entries()) {
      const email = f.email as { from: string; subject: string; text?: string; html?: string };
      const parts = [
        ...(email.text !== undefined ? [{ mimeType: 'text/plain', body: { data: encodeBase64Url(email.text) } }] : []),
        ...(email.html !== undefined ? [{ mimeType: 'text/html', body: { data: encodeBase64Url(email.html) } }] : []),
      ];
      const api: GmailApiMessage = {
        id: `g${i}`,
        internalDate: String(at),
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: email.from }, { name: 'Subject', value: email.subject }], parts },
      };
      const direct: MailMessage = { id: `g${i}`, date: at, from: email.from, subject: email.subject, ...(email.text !== undefined ? { text: email.text } : {}), ...(email.html !== undefined ? { html: email.html } : {}) };
      expect(parseAlertEmail(toMailMessage(api), cards, DEFAULT_RULES, { timeZone: 'UTC' })).toEqual(parseAlertEmail(direct, cards, DEFAULT_RULES, { timeZone: 'UTC' }));
    }
  });

  test('planAlerts: parsed, oldest first, duplicates of what the household has skipped', () => {
    const msgs: MailMessage[] = [
      { id: 'b', date: Date.UTC(2031, 2, 14, 12), from: 'alerts@bank.example.com', subject: 'Alert', text: 'You made a $5.00 transaction with KIOSK on your card ending in 1111' },
      { id: 'a', date: Date.UTC(2031, 2, 12, 12), from: 'alerts@bank.example.com', subject: 'Alert', text: 'You made a $7.25 transaction with NOODLE BAR on your card ending in 1111' },
      { id: 'c', date: Date.UTC(2031, 2, 13, 12), from: 'alerts@bank.example.com', subject: 'Payment', text: 'We received your payment of $100.00' },
    ];
    const existing = [{ id: 'st-1', date: '2031-03-13', description: 'KIOSK 12', amount: 5, card: 'Card One', source: 'statement' }];
    const plan = planAlerts(msgs, { cards: card1, rules: [], existing, timeZone: 'UTC' });
    expect(plan.create.map((t) => t.id)).toEqual(['al-a']);
    expect(plan.duplicates).toBe(1);
    expect(plan.notPurchases).toBe(1);
    expect(transactionDoc(plan.create[0], 'alert', 'alice@example.com', 1)).toEqual({
      date: '2031-03-12', description: 'NOODLE BAR', amount: 7.25, category: 'Miscellaneous', card: 'Card One', type: 'Sale', source: 'alert', last4: '1111', emailId: 'a', createdAt: 1, by: 'alice@example.com',
    });
  });

  test('toAlertInbox keeps only known fields', () => {
    expect(toAlertInbox('ib-1', { address: 'alerts.example@example.com', by: 'bob@example.com', connectedAt: 3, lastAdded: 2, error: '', token: 'x' })).toEqual({
      id: 'ib-1', address: 'alerts.example@example.com', by: 'bob@example.com', connectedAt: 3, lastAdded: 2,
    });
  });
});

describe('readAlert: only what a rule reads with confidence becomes a transaction', () => {
  const two: AlertCard[] = [
    { name: 'Card One', last4: '1111', alertWords: ['alerts@bank.example.com'] },
    { name: 'Card Two', last4: '2222', alertWords: ['alerts@bank.example.com'] },
  ];
  const sentAt = Date.UTC(2031, 9, 2, 16);
  for (const f of readings) {
    test(f.name, () => {
      const e = f.email as { from: string; subject: string; text?: string; html?: string; bulk?: boolean };
      expect(readAlert({ id: 'r1', date: sentAt, ...e }, two, DEFAULT_RULES, { timeZone: 'America/New_York' })).toEqual(f.expected as never);
    });
  }

  test('parseAlertEmail is the purchase, or null for everything else', () => {
    for (const f of readings) {
      const e = f.email as { from: string; subject: string; text?: string; html?: string; bulk?: boolean };
      const got = parseAlertEmail({ id: 'r1', date: sentAt, ...e }, two, DEFAULT_RULES, { timeZone: 'America/New_York' });
      expect(got).toEqual(f.expected.kind === 'purchase' ? (f.expected as unknown as { tx: ParsedAlert }).tx : null);
    }
  });

  test('merchants: names are trusted, prose and placeholders are not', () => {
    for (const ok of ['EXAMPLE KIOSK', 'Example Music', 'example.com', 'SHOP #12', '7-ELEVEN 123']) expect(merchantProblem(ok)).toBeNull();
    for (const bad of ['a reasonable price', 'options', 'Model', 'Card Purchase', 'your card', 'The end of the day', '123', 'x']) expect(merchantProblem(bad)).toBe('generic-merchant');
  });

  test('written dates', () => {
    expect(writtenDay('Oct 2, 2031')).toBe('2031-10-02');
    expect(writtenDay('September 30 2031')).toBe('2031-09-30');
    expect(writtenDay('10/02/31')).toBe('2031-10-02');
    expect(writtenDay('2031-10-02')).toBe('2031-10-02');
    expect(writtenDay('02/30/2031')).toBeNull();
  });

  test('List-Unsubscribe or Precedence: bulk marks a Gmail message as sent to a list', () => {
    const msg = (headers: { name: string; value: string }[]): GmailApiMessage => ({ id: 'x', internalDate: '1', payload: { headers: [{ name: 'Subject', value: 's' }, ...headers] } });
    expect(toMailMessage(msg([{ name: 'List-Unsubscribe', value: '<mailto:u@example.com>' }])).bulk).toBe(true);
    expect(toMailMessage(msg([{ name: 'Precedence', value: 'bulk' }])).bulk).toBe(true);
    expect('bulk' in toMailMessage(msg([]))).toBe(false);
  });

  test('planAlerts: unreadable emails are listed for review, never written', () => {
    const msgs: MailMessage[] = [
      { id: 'p', date: sentAt, from: 'alerts@bank.example.com', subject: 'Alert', text: 'You made a $7.25 transaction with NOODLE BAR on your card ending in 1111' },
      { id: 'u', date: sentAt - 1000, from: 'alerts@bank.example.com', subject: 'Card purchase', text: 'A charge was made on your card ending in 1111 for $40.03.' },
      { id: 'n', date: sentAt, from: 'notifications@invest.example.com', subject: 'Trade options at a reasonable price', text: 'Trade options at a reasonable price from $0.03. Unsubscribe', bulk: true },
    ];
    const plan = planAlerts(msgs, { cards: two, rules: [], existing: [], timeZone: 'UTC' });
    expect(plan.create.map((t) => t.id)).toEqual(['al-p']);
    expect(plan.notPurchases).toBe(1);
    expect(plan.review).toEqual([{ emailId: 'u', subject: 'Card purchase', sent: sentAt - 1000, date: '2031-10-02', reason: 'no-merchant', amount: 40.03 }]);
  });

  test('transactionDoc keeps the import id', () => {
    expect(transactionDoc({ date: '2031-10-02', description: 'X SHOP', amount: 1, category: 'c', card: 'Card One', type: 'Sale', importId: 'im-abc' }, 'alert', 'a@example.com', 1)).toMatchObject({ importId: 'im-abc' });
  });
});
