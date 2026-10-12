# Calendar export

The household in each person's own calendar, the opposite direction of the calendar import
(`./calendar`). Two ways in, served by [huishouden/calendar](https://github.com/huishouden/calendar):

- **A subscribed feed**: a secret iCalendar URL per person (`webcal://` or https) that any calendar
  app subscribes to.
- **Google Calendar sync**: a "Huishouden" calendar in the person's Google account, kept in step
  both ways every 5 minutes. Moving, renaming or deleting an event there changes the record in the
  app.

Plus an **Add to calendar** button on single items (`AddToCalendar`), which needs nothing set up.

## What a person sees

`exportEvents` works it out from what they can read, the same as the portal shows them:

- Helpers and kids: only items with `private: false`, and nothing from Bills or Spending.
- Personal items (Health) only for their `audience`: the person, their carers and the admins.
- Their settings (`calendarSettings/{email}`, `CalendarSettings`): apps left out (Bills among them: hiding it hides Bills and Spending items), to-dos with a due
  day (on by default), finished things (on), and Health's detail, **off by default**: a
  Health item then reads "Medicine for Ana" or "Appointment for Ana" with nothing else, since calendars are often shared
  with people outside the household. A stored `bills: false` from before Bills became an app choice reads as `hiddenApps` including `bills`.
- Their language: each item's `texts` in it, the words the export adds in it.

Every event has a stable `key` (`app|ref`, `app|ref|start` when a record has several items,
`todo|app|ref`) and a `hash` of everything a calendar shows, so a sync writes only what changed.

## Publishing for calendars

An app gives its agenda items two optional fields (`./agenda-core`, checked by the rules):

**`series`**: on each occurrence of something on a schedule (`EventRule`), so calendars show one
repeating event instead of one event per occurrence:

```ts
{ rule, time: '07:00', minutes: 30, original: '2031-10-23', through: '2031-11-30' }
```

`original` is the day the schedule put this occurrence on (the key of a move or skip in the app's
own record); `through` is the last day the app published occurrences for. A day of the rule up to
`through` with no item is a skip (EXDATE); an item whose day or time differs from the schedule is a
moved occurrence (an override). After `through` the schedule stands as it is: a change made to an
occurrence more than that far ahead shows in calendars once it is within the app's window.

**`edit`**: how a change made in the person's calendar is written back to the record, as
declarative writes on the app's own collections (`AGENDA_EDIT_COLLECTIONS`), like a to-do's Done:

```ts
edit: {
  reschedule: { ops: [{ col: 'homeEvents', id, data: { exceptions: { $original: { moved: { date: '$date', time: '$time' } } }, updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
  skip:       { ops: [{ col: 'homeEvents', id, data: { exceptions: { $original: { skipped: true } }, updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
  rename:     { ops: [{ col: 'homeEvents', id, data: { title: '$title', updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
}
```

Placeholders: `'$start'`, `'$end'` (ms), `'$date'` (YYYY-MM-DD), `'$time'` (HH:MM; the field is
removed when the event became all day), `'$title'`, `'$notes'`, `'$original'` (also as a map key, so
one edit serves every occurrence), and the to-do ones (`'$now'`, `'$today'`, `'$me'`). `roles` and
`emails` say who may (`canEdit`); the Worker then writes as that person, so the collection's own
rules still decide. Kinds: `reschedule` (moved), `retime` (a series' usual time), `rename`,
`notes`, `skip` (one occurrence deleted), `cancel` (a one-off deleted). Leave out what the app can't
do: a change in Google that has no edit is put back as the app has it.

**`calendarDetail`**: up to 200 characters that the portal never shows, for the reader's own
calendar when they turn on detail. Health puts a dose's medicine names here, and a visit's kind,
doctor, place and what to bring (`./visit` `visitAgendaItem`), since `detail` shows on the portal,
which may be on a wall tablet.

## Add to calendar

```tsx
import { AddToCalendar } from '@huishouden/pwa-kit/react/calendar';

<AddToCalendar entry={{ title, start, end, allDay, detail, location, url, series }} compact />
```

`entry` is the item as the app publishes it to the agenda. The menu offers Google Calendar (its
add-event page; a series goes in with its RRULE) and a .ics file for Apple Calendar, Outlook and the
rest. Times are in the device's zone.

## The import ignores the export

Events the Google sync writes carry the private extended property `huishouden`
(`'<household>:<key>'`), and events from the feed have UIDs ending in `@huishouden`.
`findCalendarEvents`, `toMatch` and the suggestions skip both (`isExportedEvent`), so nothing
exported comes back as "New in your calendar".

## iCalendar details (`./ics`)

RFC 5545: CRLF line ends, lines folded at 75 octets, TEXT escaping, `DTSTART;TZID=` with a
VTIMEZONE built from the runtime's own zone data (each kind of change as a yearly rule, starting the
year before the first event; irregular zones list each change), all-day events as dates with an
exclusive end, RRULE from `EventRule` (weeks counted Sunday to Saturday as the kit counts them; the
29th and 30th of the month fall on the last day of shorter months through BYSETPOS, the 31st and
29 February through BYMONTHDAY=-1), EXDATE, RECURRENCE-ID overrides, SEQUENCE (seconds since 2026
of the item's last change), LAST-MODIFIED, VALARM at the deadline of a thing to do, and
`REFRESH-INTERVAL`/`X-PUBLISHED-TTL` of an hour. `icsProblems` checks the structure; the tests also
parse every feed with ical.js and node-ical and compare their recurrence expansion with
`ruleOccurrences` for every kind of rule.
