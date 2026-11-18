import { describe, expect, it } from 'vitest'
import { matchPlantedBug } from '../src/index.js'

describe('planted bugs', () => {
  it("recognises reports of each bug in a tester's own words", () => {
    expect(matchPlantedBug('Order with a very long customer name is not saved and no error appears')?.id).toBe('silent-long-name')
    expect(matchPlantedBug('Typing jose in search finds nothing although José exists')?.id).toBe('search-accents')
    expect(matchPlantedBug('Quantity 0 gives an Internal Server Error')?.id).toBe('crash-on-zero')
    expect(matchPlantedBug('Double-clicking Save created two orders')?.id).toBe('double-submit')
    expect(matchPlantedBug('The delivery date reads 2026-11-20T00:00:00.000Z')?.id).toBe('raw-date')
  })

  it("does not count a report that only shares the mission's words, or one that fits two bugs equally", () => {
    expect(matchPlantedBug('Saving with an empty customer name does nothing')).toBeUndefined()
    expect(matchPlantedBug('Created an order for the customer Conformance Test with quantity 2 on 2026-10-18')).toBeUndefined()
  })
})
