/**
 * IPC abstraction layer for Joplin plugin webview.
 * All adapted files import from here instead of Tauri's invoke().
 * Communication happens via webviewApi.postMessage().
 */

declare const webviewApi: { postMessage(msg: any): Promise<any> };

export async function saveNoteContent(noteId: string, body: string): Promise<void> {
  await webviewApi.postMessage({ type: "saveNote", noteId, body });
}

export async function getNoteContent(noteId: string): Promise<{ id: string; title: string; body: string }> {
  return webviewApi.postMessage({ type: "getNoteContent", noteId });
}

export async function searchNotes(query: string): Promise<{ notes: Array<{ id: string; title: string; isAsciiDoc: boolean }> }> {
  return webviewApi.postMessage({ type: "searchNotes", query });
}

export async function getNoteSections(noteId: string): Promise<{ sections: Array<{ id: string; title: string; level: number }> }> {
  return webviewApi.postMessage({ type: "getNoteSections", noteId });
}

export async function renderAsciidoc(source: string): Promise<{ html: string }> {
  return webviewApi.postMessage({ type: "renderAsciidoc", source });
}

export async function openImageDialog(): Promise<{ filePath: string | null }> {
  return webviewApi.postMessage({ type: "openImageDialog" });
}

export async function createResourceFromFile(filePath: string): Promise<{ resourceId: string; title: string }> {
  return webviewApi.postMessage({ type: "createResourceFromFile", filePath });
}

export async function requestResources(resourceIds: string[]): Promise<{ resources: Array<{ id: string; dataUrl: string }> }> {
  return webviewApi.postMessage({ type: "requestResources", resourceIds });
}

export async function navigateToNote(noteId: string): Promise<void> {
  await webviewApi.postMessage({ type: "navigateToNote", noteId });
}

export async function getTemplates(): Promise<{ templates: Array<{ id: string; title: string }> }> {
  return webviewApi.postMessage({ type: "getTemplates" });
}

export async function getTemplateContent(noteId: string): Promise<{ content: string }> {
  return webviewApi.postMessage({ type: "getTemplateContent", noteId });
}

export async function markAsTemplate(): Promise<void> {
  await webviewApi.postMessage({ type: "markAsTemplate" });
}

export async function unmarkTemplate(): Promise<void> {
  await webviewApi.postMessage({ type: "unmarkTemplate" });
}

export async function getSpellcheckSettings(): Promise<{ pluralSingular: boolean }> {
  return webviewApi.postMessage({ type: "getSpellcheckSettings" });
}

export async function getPersonalDictionary(): Promise<{ words: string[] }> {
  return webviewApi.postMessage({ type: "getPersonalDictionary" });
}

export async function addWordToPersonalDictionary(word: string): Promise<void> {
  return webviewApi.postMessage({ type: "addWordToPersonalDictionary", word });
}
