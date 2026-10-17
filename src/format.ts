export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "about 7 min", "about 1 hr 5 min": a drive time is only ever a guide. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `about ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `about ${hours} hr ${rest} min` : `about ${hours} hr`
}

/** "14 Oct": short enough for a list row. */
export const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
