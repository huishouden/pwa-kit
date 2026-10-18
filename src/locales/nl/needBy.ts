import type en from '../en/needBy.js';
import type { CatalogueOf } from '../../i18n.js';

export default {
  'needBy.today': 'Vandaag nodig',
  'needBy.tomorrow': 'Morgen nodig',
  'needBy.by': 'Uiterlijk {day} nodig',
  'needBy.overdueYesterday': 'Te laat, was gisteren nodig',
  'needBy.overdue': 'Te laat, was {day} nodig',
} satisfies CatalogueOf<typeof en>;
