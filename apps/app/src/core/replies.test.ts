import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, deleteBrand } from './store.ts'
import { parsePick } from './analyze.ts'
import type { SavedReply } from './replies.ts'
import {
  addReply,
  candidates,
  deleteReply,
  fillReply,
  listReplies,
  updateReply,
} from './replies.ts'

describe('saved replies', () => {
  it('keeps clean replies per brand, with a kind only when the brand has it', () => {
    const db = openDb(':memory:')
    const a = addBrand(db, 'A', [])
    const b = addBrand(db, 'B', [])
    const key = (JSON.parse(a.categories) as { key: string }[])[0]!.key
    const r = addReply(db, a.id, { title: '  Refund   ', text: 'Hi {name}, ', category: key })
    expect(r).toMatchObject({ title: 'Refund', text: 'Hi {name},', category: key })
    expect(addReply(db, a.id, { title: 'X', text: 'y', category: 'made-up' }).category).toBeNull()
    expect(() => addReply(db, a.id, { title: '', text: 'y' })).toThrow('title')
    expect(() => addReply(db, a.id, { title: 'x', text: ' ' })).toThrow('text')

    // Another brand's admin cannot change or remove it through their own brand.
    expect(() => updateReply(db, b.id, r.id, { title: 'T', text: 'x' })).toThrow('No such')
    deleteReply(db, b.id, r.id)
    expect(listReplies(db, a.id)).toHaveLength(2)

    expect(updateReply(db, a.id, r.id, { title: 'Refunds', text: 'ok' }).title).toBe('Refunds')
    deleteReply(db, a.id, r.id)
    expect(listReplies(db, a.id).map((x) => x.title)).toEqual(['X'])
    deleteBrand(db, a.id)
    expect(listReplies(db, a.id)).toEqual([])
  })

  it('shows Claude the replies for the comment’s kind first', () => {
    const r = (id: number, category: string | null) =>
      ({ id, title: `t${id}`, text: '', category }) as SavedReply
    const list = [r(1, 'price'), r(2, null), r(3, 'delivery'), r(4, 'delivery')]
    expect(candidates(list, 'delivery').map((x) => x.id)).toEqual([3, 4, 2, 1])
    expect(candidates(list, null).map((x) => x.id)).toEqual([2, 1, 3, 4])
    expect(candidates(list, 'delivery', 2).map((x) => x.id)).toEqual([3, 4])
  })

  it('fills the placeholders it knows and leaves the rest for a person', () => {
    expect(fillReply('Hi {name}, {Name} and {NAME}: order {order}.', { name: 'ana' })).toBe(
      'Hi ana, ana and ana: order {order}.',
    )
  })

  it('reads which saved reply Claude chose, or a fresh draft', () => {
    expect(parsePick('2|Hi Ana, your refund is on its way.', 3)).toEqual({
      index: 1,
      text: 'Hi Ana, your refund is on its way.',
    })
    expect(parsePick('0|Sorry about that!\nWrite to us.', 3)).toEqual({
      index: null,
      text: 'Sorry about that!\nWrite to us.',
    })
    // A model that echoes the saved reply's title and kind has them taken off.
    expect(parsePick('2|Tavelo Pass|any|Hi Sara! It is for everyone.', 3)).toEqual({
      index: 1,
      text: 'Hi Sara! It is for everyone.',
    })
    // Out of range or without the lead: the text is kept as a fresh draft.
    expect(parsePick('7|Hello', 3)).toEqual({ index: null, text: 'Hello' })
    expect(parsePick('Thanks a lot!', 3)).toEqual({ index: null, text: 'Thanks a lot!' })
  })
})
