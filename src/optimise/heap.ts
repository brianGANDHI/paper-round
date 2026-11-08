/** A binary min-heap of values by key, in two plain arrays: the road searches push and pop millions of these, so it allocates nothing per item. */
export class MinHeap {
  private keys: number[] = []
  private values: number[] = []

  get size(): number {
    return this.keys.length
  }

  /** The smallest key, to read before `pop`. */
  get topKey(): number {
    return this.keys[0]
  }

  push(key: number, value: number): void {
    const { keys, values } = this
    let i = keys.length
    keys.push(key)
    values.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      keys[i] = keys[parent]
      values[i] = values[parent]
      i = parent
    }
    keys[i] = key
    values[i] = value
  }

  /** Takes the value with the smallest key off the heap. */
  pop(): number {
    const { keys, values } = this
    const top = values[0]
    const lastKey = keys.pop() as number
    const lastValue = values.pop() as number
    const n = keys.length
    if (n) {
      let i = 0
      for (;;) {
        let child = 2 * i + 1
        if (child >= n) break
        if (child + 1 < n && keys[child + 1] < keys[child]) child++
        if (keys[child] >= lastKey) break
        keys[i] = keys[child]
        values[i] = values[child]
        i = child
      }
      keys[i] = lastKey
      values[i] = lastValue
    }
    return top
  }
}
