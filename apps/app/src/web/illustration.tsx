import calendar from 'shades-gradient/illustrations/calendar.svg?raw'
import chart from 'shades-gradient/illustrations/chart.svg?raw'
import error from 'shades-gradient/illustrations/error.svg?raw'
import filter from 'shades-gradient/illustrations/filter.svg?raw'
import folder from 'shades-gradient/illustrations/folder.svg?raw'
import inbox from 'shades-gradient/illustrations/inbox.svg?raw'
import nothing from 'shades-gradient/illustrations/nothing.svg?raw'
import offline from 'shades-gradient/illustrations/offline.svg?raw'
import photo from 'shades-gradient/illustrations/photo.svg?raw'
import peopleCalendar from 'shades-gradient/illustrations/people-calendar.svg?raw'
import peopleChart from 'shades-gradient/illustrations/people-chart.svg?raw'
import peopleChecklist from 'shades-gradient/illustrations/people-checklist.svg?raw'
import peopleEmpty from 'shades-gradient/illustrations/people-empty.svg?raw'
import peopleError from 'shades-gradient/illustrations/people-error.svg?raw'
import peopleLocked from 'shades-gradient/illustrations/people-locked.svg?raw'
import peopleLookup from 'shades-gradient/illustrations/people-lookup.svg?raw'
import peopleOffline from 'shades-gradient/illustrations/people-offline.svg?raw'
import peoplePick from 'shades-gradient/illustrations/people-pick.svg?raw'
import peopleSearch from 'shades-gradient/illustrations/people-search.svg?raw'
import peopleTeam from 'shades-gradient/illustrations/people-team.svg?raw'
import peopleInbox from 'shades-gradient/illustrations/people-inbox.svg?raw'
import peopleWelcome from 'shades-gradient/illustrations/people-welcome.svg?raw'

/**
 * Gradient's spot drawings, one per empty, error or first-time screen, each the one that means
 * that screen: objects, people, and people acting with an object, mixed. Inlined so they take
 * the theme's --g-ill-* colours in light and dark. The SVG text comes from the shades-gradient
 * package at build time, never from a user.
 */
const ART = {
  calendar,
  chart,
  error,
  filter,
  folder,
  inbox,
  nothing,
  offline,
  photo,
  'people-calendar': peopleCalendar,
  'people-chart': peopleChart,
  'people-checklist': peopleChecklist,
  'people-empty': peopleEmpty,
  'people-error': peopleError,
  'people-locked': peopleLocked,
  'people-lookup': peopleLookup,
  'people-offline': peopleOffline,
  'people-pick': peoplePick,
  'people-search': peopleSearch,
  'people-team': peopleTeam,
  'people-inbox': peopleInbox,
  'people-welcome': peopleWelcome,
} as const
export type ArtName = keyof typeof ART

export const Illustration = ({ name }: { name: ArtName }) => (
  <span
    class={`sm-ill${name.startsWith('people-') ? ' sm-ill--people' : ''}`}
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: ART[name] }}
  />
)
