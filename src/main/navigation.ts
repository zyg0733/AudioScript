import type { SidebarItem } from '@/ui/Sidebar'

export type PageId =
  | 'transcribe'
  | 'library'
  | 'audio'
  | 'permissions'
  | 'translate'
  | 'overlay'
  | 'general'
  | 'models'
  | 'about'

export const NAV: SidebarItem<PageId>[] = [
  {
    id: 'transcribe',
    label: '转写',
    icon: 'waveform',
  },
  { id: 'library', label: '资料库', icon: 'folder' },
  {
    id: 'audio',
    label: '音频',
    icon: 'speaker',
  },
  { id: 'permissions', label: '权限', icon: 'shield' },
  {
    id: 'translate',
    label: '翻译',
    icon: 'translate',
  },
  {
    id: 'overlay',
    label: '悬浮窗',
    icon: 'overlay',
  },
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'models', label: '模型', icon: 'chip' },
  { id: 'about', label: '关于', icon: 'info' },
]
