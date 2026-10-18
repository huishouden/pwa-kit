/**
 * Every collection under `households/{id}` that the rules let someone write, and how the household
 * tools reach it. huishouden/rules' test fails when a collection the rules allow writes to is not
 * listed here, and the kit's test fails when a tool named here doesn't exist, so a new kind of
 * household data arrives with its tool, or with the reason it has none, in the same change set
 * (STANDARD.md "Household tools").
 *
 * - `tools`: what a person edits there is covered by these tools (reads and writes). `partly` says
 *   what is not covered yet.
 * - `internal`: nobody edits it as such: derived from other records by the apps or the Workers, a
 *   device's or a sign-in's plumbing, or set up through a consent only the app can show.
 * - `gap`: people edit it in an app and no tool reaches it yet: what is missing.
 *
 * Keys are collection paths with the parent ids left out: `healthPeople/meds`, `stores/aisles`.
 * Imports nothing, so `@huishouden/pwa-kit/household-tools/coverage` loads without zod.
 */
export type Coverage = { tools: readonly string[]; partly?: string } | { internal: string } | { gap: string };

export const COVERAGE: Readonly<Record<string, Coverage>> = {
  // Tasks and Groceries
  lists: { gap: 'Create, rename or remove a task or grocery list.' },
  items: { tools: ['groceries_list', 'groceries_add', 'groceries_check', 'groceries_update', 'tasks_add', 'todos', 'todo_done', 'todo_cancel'], partly: 'Renaming, moving or deleting a shopping item; editing or deleting a task, and reading a task list as such.' },
  staples: { gap: "Counts Groceries keeps as items are added and ticked (derived); a person sets a staple's category or stops it being suggested." },
  stores: { gap: 'Add or edit a store.' },
  'stores/aisles': { gap: 'Which aisle an item is in at a store.' },
  favorites: { gap: 'Favourite meals.' },
  menus: { gap: 'Meal ideas (menus).' },
  mealPlan: { gap: "Read or plan the week's meals." },
  settings: { gap: "Food preferences (`food`); also the portal's tile layout (`portal`) and the Google Tasks links (`tasks`)." },

  // Spending
  spendingTransactions: { gap: 'Read spending, add or recategorise a transaction.' },
  spendingSettings: { gap: 'Budget, currency, words never counted.' },
  spendingCards: { gap: 'Add or edit a card.' },
  spendingRules: { gap: 'Category rules ("when the merchant contains X, the category is Y").' },
  spendingInboxes: { internal: 'A Gmail inbox a member connected for card alerts: set up through Google consent in the app.' },

  // Baby
  babyProfile: { gap: "The baby's name and due date." },
  babyContractionSettings: { tools: ['baby_settings', 'baby_set_contraction_note'] },
  babyEvents: { gap: 'Log or read feeds, sleeps, diapers and pumping.' },
  babyChecklists: { tools: ['todos', 'todo_done'], partly: 'Adding, editing or skipping a checklist item.' },
  babyContractions: { gap: 'Read the contractions timed, or start and stop one.' },
  babyKickSettings: { tools: ['baby_settings', 'baby_set_kick_settings'] },
  babyKickSessions: { gap: 'Read kick counts, or count one.' },
  babyAppointments: { tools: ['add_appointment', 'calendar'], partly: 'Editing or cancelling an appointment.' },

  // Car
  carVehicles: { gap: 'Add or edit a vehicle (add_appointment only reads them).' },
  carServiceItems: { gap: 'Service schedule items (oil change every N miles or months).' },
  carOdometer: { gap: 'Log an odometer reading.' },
  carRenewals: { tools: ['todos', 'todo_done', 'calendar'], partly: 'Adding or editing a renewal.' },
  carServiceLog: { gap: 'Log a service done.' },
  carAppointments: { tools: ['add_appointment', 'calendar'], partly: 'Editing or cancelling an appointment.' },
  carSettings: { gap: 'The unit the odometers read in.' },

  // Home
  homeTasks: { tools: ['home_upkeep_due', 'todos', 'todo_done'], partly: 'Adding or editing an upkeep job.' },
  homeServiceLog: { tools: ['home_add_event'], partly: 'Reading the service history.' },
  homeWarranties: { gap: 'Warranties.' },
  homeEvents: { tools: ['home_add_event', 'calendar'], partly: 'Editing or removing a regular event.' },
  homeEventPrep: { gap: 'Tick off a thing to do before an event (put the bins out).' },

  // Bills
  billSources: { gap: 'Where bills come from (an account, a biller).' },
  bills: { tools: ['bills_due', 'todos', 'todo_done'], partly: 'Adding, editing or skipping a bill; marking it unpaid.' },
  billSuggestions: { gap: 'Answer a suggested bill (add it, or "Not a bill").' },
  billSettings: { gap: 'Bill reminders: which bills remind and when.' },
  billSync: { internal: "A member's own record of their last bill check." },

  // Pet
  petProfiles: { tools: ['pet_today'], partly: 'Adding or editing a pet.' },
  petReminders: { tools: ['pet_today', 'pet_log_dose', 'todo_done'], partly: 'Adding or editing a care reminder.' },
  petDoses: { tools: ['pet_log_dose'] },
  petAppointments: { tools: ['add_appointment', 'calendar'], partly: 'Editing or cancelling an appointment.' },
  petWeights: { gap: 'Log or read a weight.' },
  petRecords: { gap: 'Health records (vaccines, vet visits) kept on file.' },
  petMeals: { tools: ['pet_today'], partly: 'Setting up or changing the feeding board.' },
  petFeedings: { tools: ['pet_log_feeding'] },
  petMedCourses: { tools: ['pet_today', 'pet_log_dose'], partly: 'Adding or changing a medicine course.' },
  petOutingPlans: { tools: ['pet_today'], partly: 'Setting up the outing schedule.' },
  petOutings: { tools: ['pet_log_outing'] },
  petRoutines: { tools: ['pet_routines'], partly: 'Adding or changing a care routine.' },
  petRoutineLogs: { tools: ['pet_routine_done'] },
  petPhotos: { internal: "A pet's avatar photo, picked from the device in the app." },
  petMedDoses: { tools: ['pet_log_dose'] },

  // The portal and the household
  profiles: { internal: "A member's name and photo, written from their Google account on sign-in (the portal adds language and time zone)." },
  contactPay: { gap: "A contact's pay details (Zelle, Venmo, bank, check address)." },
  contacts: { tools: ['contacts_search', 'contacts_add'], partly: 'Editing or deleting a contact.' },
  reminders: { internal: "Reminders the apps derive from their records (each tool that changes a record schedules the record's)." },
  agenda: { internal: 'Calendar items the apps derive from their records.' },
  todos: { tools: ['todos', 'todo_done', 'todo_cancel'] },
  personalAgenda: { internal: 'Calendar items for named members, derived from records (Health visits).' },
  personalTodos: { tools: ['todos', 'todo_done', 'todo_cancel'] },
  personalReminders: { internal: 'Reminders for named members, derived from records (Health doses and visits).' },
  calendarSettings: { gap: "A member's own calendar feed settings: which apps, to-dos, bills and Health detail go in." },
  calendarChanges: { internal: 'Changes huishouden/calendar carried back from Google Calendar, kept for undo.' },
  connections: { internal: "A member's assistant connections (the connector's grants)." },
  'connections/audit': { internal: "The connector's audit log of a connection." },
  notificationPrefs: { gap: "A member's muted apps for notifications." },
  pushSubscriptions: { internal: "A device's push subscription." },

  // Health
  healthPeople: { tools: ['health_people'], partly: 'Adding a person or changing who cares for them.' },
  'healthPeople/photo': { internal: "A person's photo, picked from the device in the app." },
  'healthPeople/meds': { tools: ['health_medicines', 'health_add_medicine', 'health_update_medicine', 'health_due', 'health_doctor_list'] },
  'healthPeople/doses': { tools: ['health_log_dose', 'health_history', 'health_due'] },
  'healthPeople/visits': { tools: ['add_appointment', 'health_appointments'], partly: 'Editing a visit or marking it attended or missed.' },
  'healthPeople/visitNotes': { tools: ['add_appointment', 'health_appointments'] },
  'healthPeople/conditions': { tools: ['health_conditions', 'health_add_condition'], partly: 'Editing or resolving a condition.' },
};

/** What is not covered yet: each collection with no tool (`gap`) or only some (`partly`), and what is missing. */
export interface CoverageGap {
  collection: string;
  kind: 'gap' | 'partly';
  missing: string;
}

export const coverageGaps = (): CoverageGap[] =>
  Object.entries(COVERAGE).flatMap(([collection, c]): CoverageGap[] =>
    'gap' in c ? [{ collection, kind: 'gap', missing: c.gap }] : 'tools' in c && c.partly ? [{ collection, kind: 'partly', missing: c.partly }] : [],
  );
