/** A brand's tabs, in menu order, by their English names (translated where shown). */
export const TABS = [
  ['overview', 'Overview'],
  ['posts', 'Posts'],
  ['stats', 'Statistics'],
  ['voice', 'Share of voice'],
  ['ads', 'Ads'],
  ['comments', 'Comments'],
  ['calendar', 'Calendar'],
  ['reports', 'Reports'],
  ['schedules', 'Schedules'],
  ['about', 'About'],
  ['settings', 'Settings'],
  ['admin', 'Admin'],
] as const
export type Tab = (typeof TABS)[number][0]

/** Tabs only a brand's admins (and super admins) see. */
const ADMIN_TABS: string[] = ['schedules', 'settings']

/**
 * The tabs someone sees on a brand: by their role, with Share of voice only while its switch is
 * on, and Admin and Ads for super admins alone (Ads only while its switch is on).
 */
export const tabsFor = (
  brand: { my_role: string | null | undefined; competition?: boolean; ads?: boolean },
  isSuper = false,
) =>
  TABS.filter(([k]) =>
    k === 'admin'
      ? isSuper
      : k === 'ads'
        ? isSuper && brand.ads === true
        : k === 'voice'
          ? brand.competition !== false
          : brand.my_role === 'admin' || !ADMIN_TABS.includes(k),
  )
