export interface EntryDraft {
  textEdit?: {
    text: string
    translation: string
    base: { revision: number; text: string; translation: string }
  }
  noteEdit?: { note: string; base: { revision: number; note: string } }
}

export type RecordDrafts = Record<string, EntryDraft>
const memory = new Map<string, RecordDrafts>()
const prefix = 'audioscript:library-drafts:'

export function readDrafts(recordId: string): RecordDrafts {
  const cached = memory.get(recordId)
  if (cached) return cached
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(prefix + recordId) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: RecordDrafts = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const { textEdit, noteEdit } = value as EntryDraft
      const draft: EntryDraft = {}
      if (
        textEdit &&
        typeof textEdit.text === 'string' &&
        typeof textEdit.translation === 'string' &&
        Number.isSafeInteger(textEdit.base?.revision) &&
        typeof textEdit.base?.text === 'string' &&
        typeof textEdit.base?.translation === 'string'
      )
        draft.textEdit = textEdit
      if (
        noteEdit &&
        typeof noteEdit.note === 'string' &&
        Number.isSafeInteger(noteEdit.base?.revision) &&
        typeof noteEdit.base?.note === 'string'
      )
        draft.noteEdit = noteEdit
      if (draft.textEdit || draft.noteEdit) drafts[id] = draft
    }
    memory.set(recordId, drafts)
    return drafts
  } catch {
    return {}
  }
}

export function writeDrafts(recordId: string, drafts: RecordDrafts) {
  memory.set(recordId, drafts)
  try {
    if (Object.keys(drafts).length) sessionStorage.setItem(prefix + recordId, JSON.stringify(drafts))
    else sessionStorage.removeItem(prefix + recordId)
  } catch {
    // 存储不可用时仍在当前窗口内保留草稿。
  }
}

export function clearDrafts(recordId: string) {
  writeDrafts(recordId, {})
}

export function draftChanged(draft: EntryDraft): boolean {
  return Boolean(
    (draft.textEdit &&
      (draft.textEdit.text !== draft.textEdit.base.text ||
        draft.textEdit.translation !== draft.textEdit.base.translation)) ||
      (draft.noteEdit && draft.noteEdit.note !== draft.noteEdit.base.note),
  )
}
