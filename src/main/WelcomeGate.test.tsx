import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomeGate } from './WelcomeGate'

const mocks = vi.hoisted(() => ({
  completeOnboarding: vi.fn(),
  error: null as string | null,
}))

vi.mock('@/main/store', () => ({
  useStore: () => ({
    info: { name: 'AudioScript' },
    error: mocks.error,
    completeOnboarding: mocks.completeOnboarding,
  }),
}))

vi.mock('@/main/permissions/PermissionPanel', () => ({ PermissionPanel: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('WelcomeGate onboarding persistence', () => {
  let container: HTMLDivElement
  let root: Root

  function buttons() {
    return Array.from(container.querySelectorAll('button'))
  }

  beforeEach(() => {
    mocks.error = null
    mocks.completeOnboarding.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('shows settings failures that occur before onboarding opens', async () => {
    mocks.error = '读取设置失败：无法访问设置文件'
    await act(async () => root.render(<WelcomeGate />))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(mocks.error)
    expect(buttons().every((button) => !button.disabled)).toBe(true)
  })

  it('blocks duplicate submissions, exposes a save failure and permits retry', async () => {
    let failSave!: () => void
    mocks.completeOnboarding.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          failSave = () => {
            mocks.error = '保存设置失败：空间不足'
            resolve()
          }
        }),
    )
    await act(async () => root.render(<WelcomeGate />))
    const start = buttons().find((button) => button.textContent === '开始使用')
    if (!start) throw new Error('开始使用按钮未找到')

    await act(async () => {
      start.click()
      start.click()
    })
    expect(mocks.completeOnboarding).toHaveBeenCalledOnce()
    expect(buttons().every((button) => button.disabled)).toBe(true)
    expect(container.textContent).toContain('正在保存')

    await act(async () => failSave())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('空间不足')
    expect(buttons().every((button) => !button.disabled)).toBe(true)

    mocks.completeOnboarding.mockImplementationOnce(async () => {
      mocks.error = null
    })
    await act(async () => start.click())
    expect(mocks.completeOnboarding).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(buttons().every((button) => !button.disabled)).toBe(true)
  })
})
