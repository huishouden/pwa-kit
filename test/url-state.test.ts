import { GlobalRegistrator } from './dom';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { URL_CHANGE_EVENT, onUrlChange, setUrlParams, tabFromUrl, urlParam, withParams } from '../src/url-state';

beforeAll(() => {
  if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://suite.example.com/pet/' });
});
afterAll(() => GlobalRegistrator.unregister());

describe('url-state', () => {
  test('withParams sets and removes parameters, keeping the path, the rest of the query and the fragment', () => {
    expect(withParams('https://x.test/pet/?tab=care&pet=p1#top', { tab: 'pets', pet: null })).toBe('https://x.test/pet/?tab=pets#top');
    expect(withParams('https://x.test/pet/?tab=care', { tab: '' })).toBe('https://x.test/pet/');
  });

  test('tabFromUrl: the query, else a legacy fragment, else the first screen', () => {
    const ids = ['home', 'care', 'pets'] as const;
    expect(tabFromUrl('https://x.test/pet/?tab=care', ids, 'home')).toBe('care');
    expect(tabFromUrl('https://x.test/pet/?tab=nope', ids, 'home')).toBe('home');
    expect(tabFromUrl('https://x.test/pet/#pets', ids, 'home')).toBe('home');
    expect(tabFromUrl('https://x.test/pet/#pets', ids, 'home', { legacyHash: true })).toBe('pets');
    expect(tabFromUrl('https://x.test/pet/?view=pets', ids, 'home', { param: 'view' })).toBe('pets');
    expect(tabFromUrl('https://x.test/pet/?tab=care#pets', ids, 'home', { legacyHash: true }), 'a fragment link just followed wins').toBe('pets');
    expect(tabFromUrl('https://x.test/pet/?tab=care#top', ids, 'home', { legacyHash: true })).toBe('care');
  });

  test('setUrlParams pushes an entry (or replaces it) and tells listeners; Back is a popstate they hear too', () => {
    history.replaceState(null, '', '/pet/');
    const heard: string[] = [];
    const off = onUrlChange(() => heard.push(location.search));
    const before = history.length;
    setUrlParams({ tab: 'care' });
    expect(urlParam('tab')).toBe('care');
    expect(history.length).toBe(before + 1);
    setUrlParams({ pet: 'p1' }, { replace: true });
    expect(history.length).toBe(before + 1);
    expect(location.search).toBe('?tab=care&pet=p1');
    setUrlParams({ pet: 'p1' });
    expect(history.length, 'no entry when nothing changes').toBe(before + 1);
    dispatchEvent(new Event('popstate'));
    off();
    setUrlParams({ tab: null });
    expect(heard).toEqual(['?tab=care', '?tab=care&pet=p1', '?tab=care&pet=p1']);
    expect(URL_CHANGE_EVENT).toBe('hh-urlchange');
  });
});
