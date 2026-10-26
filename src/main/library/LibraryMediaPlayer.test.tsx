import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LibraryMediaPlayer } from './LibraryMediaPlayer'
import { libraryRecord } from './test-fixtures'

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://localhost${path}` }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('LibraryMediaPlayer reference playback', () => {
  let container: HTMLDivElement
  let root: Root
  let play: ReturnType<typeof vi.spyOn>
  let pause: ReturnType<typeof vi.spyOn>
  const createObjectURL = vi.fn(() => 'blob:captions')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('seeks to a cited segment and stops at the end of the requested clip', async () => {
    await act(async () =>
      root.render(
        <LibraryMediaPlayer
          path="/library/media/course.mp4"
          segments={libraryRecord().segments.map((entry) => entry.segment)}
          target={{ startMs: 10000, endMs: 14000, play: true, sequence: 1 }}
        />,
      ),
    )
    const video = container.querySelector('video')
    if (!video) throw new Error('视频播放器未找到')
    expect(video.src).toContain('/library/media/course.mp4')
    expect(video.currentTime).toBe(10)
    expect(play).toHaveBeenCalledOnce()
    expect(video.querySelector('track')?.src).toBe('blob:captions')
    await act(async () => {
      video.currentTime = 14.1
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(pause).toHaveBeenCalledOnce()
  })

  it('keeps an audio reference seek paused until the user requests playback', async () => {
    await act(async () =>
      root.render(
        <LibraryMediaPlayer
          path="/library/media/course.wav"
          segments={[]}
          target={{ startMs: 5000, play: false, sequence: 1 }}
        />,
      ),
    )
    expect(container.querySelector('audio')?.currentTime).toBe(5)
    expect(play).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:captions')
  })
})
