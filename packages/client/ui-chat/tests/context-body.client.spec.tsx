// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { NoticeBody, SnapshotBody } from '../src/client/chat/ContextBody.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)

describe('NoticeBody, content past the 20,000-char display bound', () => {
  it('offers a control to reveal the rest of the text instead of a permanent cutoff', () => {
    const longText = `${'A'.repeat(20_000)}TAIL_MARKER`
    const view = render(<NoticeBody content={[{ type: 'text', text: longText }]} source={{}} t={t} />)

    expect(view.queryByText(/TAIL_MARKER/)).toBeNull()

    fireEvent.click(view.getByRole('button'))

    expect(view.getByText(/TAIL_MARKER/)).toBeTruthy()
  })

  it('renders short content plainly, with no expand control', () => {
    const view = render(<NoticeBody content={[{ type: 'text', text: 'short' }]} source={{}} t={t} />)
    expect(view.getByText('short')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })
})

describe('SnapshotBody, a section past the 20,000-char display bound', () => {
  it('offers a control to reveal the rest of that section\'s text instead of a permanent cutoff', () => {
    const longText = `${'A'.repeat(20_000)}TAIL_MARKER`
    const view = render(
      <SnapshotBody
        content={[{ type: 'text', text: 'ignored — SnapshotBody reads sections off source' }]}
        source={{ sections: [{ name: 'sandbox', text: longText }] }}
        t={t}
      />,
    )

    expect(view.queryByText(/TAIL_MARKER/)).toBeNull()

    fireEvent.click(view.getByRole('button'))

    expect(view.getByText(/TAIL_MARKER/)).toBeTruthy()
  })
})
