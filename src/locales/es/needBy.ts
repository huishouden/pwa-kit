import type en from '../en/needBy.js';
import type { CatalogueOf } from '../../i18n.js';

export default {
  'needBy.today': 'Para hoy',
  'needBy.tomorrow': 'Para mañana',
  'needBy.by': 'Para el {day}',
  'needBy.overdueYesterday': 'Atrasado, era para ayer',
  'needBy.overdue': 'Atrasado, era para el {day}',
} satisfies CatalogueOf<typeof en>;
