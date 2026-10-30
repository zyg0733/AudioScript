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
    localStorage.clear()
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
          recordId="record-1"
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
          recordId="record-1"
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

  it('restores a record position and speed without autoplay, and displays its current bilingual subtitle', async () => {
    const path = '/library/media/course.wav'
    localStorage.setItem('audioscript:playback:record-1', JSON.stringify({ path, position: 11, rate: '1.5' }))
    await act(async () =>
      root.render(
        <LibraryMediaPlayer
          recordId="record-1"
          path={path}
          segments={libraryRecord().segments.map((entry) => entry.segment)}
          target={null}
        />,
      ),
    )
    const audio = container.querySelector('audio')
    if (!audio) throw new Error('音频播放器未找到')
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true })
    await act(async () => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(audio.currentTime).toBe(11)
    expect(audio.playbackRate).toBe(1.5)
    expect(play).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已恢复到 0:11')
    const caption = container.querySelector('[aria-label="当前播放字幕"]')
    expect(caption?.textContent).toContain('Memory needs ownership.')
    expect(caption?.textContent).toContain('内存需要所有权。')
    await act(async () => {
      audio.currentTime = 5
      audio.dispatchEvent(new Event('timeupdate'))
    })
    expect(caption?.textContent).not.toContain('Memory needs ownership.')
    const speed = container.querySelector<HTMLSelectElement>('[aria-label="播放速度"]')
    if (!speed) throw new Error('倍速选择器未找到')
    await act(async () => {
      speed.value = '2'
      speed.dispatchEvent(new Event('change', { bubbles: true }))
      audio.dispatchEvent(new Event('pause'))
    })
    expect(audio.playbackRate).toBe(2)
    expect(JSON.parse(localStorage.getItem('audioscript:playback:record-1') ?? '{}')).toEqual({
      path,
      position: 5,
      rate: '2',
    })
  })

  it('loops the requested clip and releases its boundary when the user seeks elsewhere', async () => {
    await act(async () =>
      root.render(
        <LibraryMediaPlayer
          recordId="record-1"
          path="/library/media/course.wav"
          segments={[]}
          target={{ startMs: 10000, endMs: 14000, play: true, sequence: 1 }}
        />,
      ),
    )
    const audio = container.querySelector('audio')
    const loop = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!audio || !loop) throw new Error('循环控件未找到')
    await act(async () => loop.click())
    await act(async () => {
      audio.currentTime = 14.1
      audio.dispatchEvent(new Event('timeupdate'))
    })
    expect(audio.currentTime).toBe(10)
    expect(pause).not.toHaveBeenCalled()
    await act(async () => {
      audio.currentTime = 30
      audio.dispatchEvent(new Event('seeking'))
      audio.dispatchEvent(new Event('timeupdate'))
    })
    expect(audio.currentTime).toBe(30)
    expect(pause).not.toHaveBeenCalled()
  })

  it('keeps saved progress separated by record and media source', async () => {
    const path = '/library/media/course.wav'
    await act(async () =>
      root.render(<LibraryMediaPlayer recordId="record-1" path={path} segments={[]} target={null} />),
    )
    const first = container.querySelector('audio')
    if (!first) throw new Error('音频播放器未找到')
    Object.defineProperty(first, 'duration', { value: 100, configurable: true })
    await act(async () => {
      first.dispatchEvent(new Event('loadedmetadata'))
      first.currentTime = 23
      first.dispatchEvent(new Event('timeupdate'))
    })
    await act(async () =>
      root.render(<LibraryMediaPlayer recordId="record-2" path={path} segments={[]} target={null} />),
    )
    expect(JSON.parse(localStorage.getItem('audioscript:playback:record-1') ?? '{}').position).toBe(23)
    expect(localStorage.getItem('audioscript:playback:record-2')).toBeNull()
    await act(async () => root.render(null))
    await act(async () =>
      root.render(
        <LibraryMediaPlayer recordId="record-1" path="/library/media/replacement.wav" segments={[]} target={null} />,
      ),
    )
    const replacement = container.querySelector('audio')
    if (!replacement) throw new Error('新媒体播放器未找到')
    Object.defineProperty(replacement, 'duration', { value: 100, configurable: true })
    await act(async () => replacement.dispatchEvent(new Event('loadedmetadata')))
    expect(replacement.currentTime).toBe(0)
  })

  it('continues playback when local storage is unavailable or contains invalid progress', async () => {
    const path = '/library/media/course.wav'
    localStorage.setItem('audioscript:playback:record-1', JSON.stringify({ path, position: '23', rate: 'Infinity' }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('空间不足')
    })
    await act(async () =>
      root.render(<LibraryMediaPlayer recordId="record-1" path={path} segments={[]} target={null} />),
    )
    const audio = container.querySelector('audio')
    if (!audio) throw new Error('音频播放器未找到')
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true })
    await act(async () => {
      audio.dispatchEvent(new Event('loadedmetadata'))
      audio.currentTime = 9
      audio.dispatchEvent(new Event('timeupdate'))
      audio.dispatchEvent(new Event('pause'))
    })
    expect(audio.playbackRate).toBe(1)
    expect(audio.currentTime).toBe(9)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
