import en from './locales/en.js';
import { registerKitMessages, t as anyT, type Vars } from '../i18n.js';

/**
 * The household tools' words (English imported, Spanish and Dutch loaded on first use), registered
 * as the kit's own catalogue, so `withLang` and `loadLang` switch them too and a test's
 * `resetI18nForTests` keeps them for the test files after it.
 */
registerKitMessages(en, { es: () => import('./locales/es.js'), nl: () => import('./locales/nl.js') });

export type ToolMessageKey = keyof typeof en;

/** A household tool's message in the current language (`withLang`), formatted. */
export const t = (key: ToolMessageKey, vars?: Vars): string => anyT(key as never, vars);
