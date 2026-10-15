export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "14 Oct": short enough for a list row. */
export const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
