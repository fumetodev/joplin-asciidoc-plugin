/**
 * Type declarations for Joplin's runtime-provided `api` module.
 * These are stub types — the real implementation is injected by Joplin at runtime.
 */

// Joplin injects 'joplin' as a global in the plugin sandbox.
// The 'api' module just re-exports it for TypeScript import compatibility.
declare module "api" {
  interface JoplinData {
    get(path: string[], query?: any): Promise<any>;
    post(path: string[], query: any, body: any, files?: any[]): Promise<any>;
    put(path: string[], query: any, body: any): Promise<any>;
    delete(path: string[]): Promise<any>;
    resourcePath(id: string): Promise<string>;
  }

  interface JoplinWorkspace {
    selectedNote(): Promise<any>;
    selectedFolder(): Promise<any>;
    onNoteSelectionChange(callback: (event: { value: string[] }) => void): Promise<any>;
  }

  interface JoplinCommands {
    register(command: any): Promise<void>;
    execute(name: string, ...args: any[]): Promise<any>;
  }

  interface JoplinViewsEditors {
    register(id: string, spec: any): Promise<any>;
    setHtml(handle: any, html: string): Promise<void>;
    addScript(handle: any, path: string): Promise<void>;
    onUpdate(handle: any, callback: (update: any) => Promise<void>): Promise<void>;
    onMessage(handle: any, callback: (msg: any) => Promise<any>): Promise<void>;
    postMessage(handle: any, msg: any): void;
    saveNote(handle: any, data: any): Promise<void>;
  }

  interface JoplinViewsDialogs {
    create(id: string): Promise<any>;
    setHtml(handle: any, html: string): Promise<void>;
    setButtons(handle: any, buttons: any[]): Promise<void>;
    open(handle: any): Promise<any>;
    showOpenDialog(options: any): Promise<any>;
  }

  interface JoplinViewsMenuItems {
    create(id: string, commandName: string, location: any): Promise<void>;
  }

  interface JoplinViewsToolbarButtons {
    create(id: string, commandName: string, location: any): Promise<void>;
  }

  interface JoplinViews {
    editors: JoplinViewsEditors;
    dialogs: JoplinViewsDialogs;
    menuItems: JoplinViewsMenuItems;
    toolbarButtons: JoplinViewsToolbarButtons;
  }

  interface JoplinSettings {
    registerSection(id: string, spec: any): Promise<void>;
    registerSettings(settings: any): Promise<void>;
    value(key: string): Promise<any>;
    setValue(key: string, value: any): Promise<void>;
  }

  interface JoplinPlugins {
    register(spec: { onStart: () => Promise<void> }): void;
  }

  interface Joplin {
    data: JoplinData;
    workspace: JoplinWorkspace;
    commands: JoplinCommands;
    views: JoplinViews;
    settings: JoplinSettings;
    plugins: JoplinPlugins;
    shouldUseDarkColors(): Promise<boolean>;
    require(module: string): any;
  }

  const joplin: Joplin;
  export default joplin;
}

declare module "api/types" {
  export enum ContentScriptType {
    MarkdownItPlugin = "markdownItPlugin",
    CodeMirrorPlugin = "codeMirrorPlugin",
  }

  export enum MenuItemLocation {
    File = "file",
    Edit = "edit",
    View = "view",
    Note = "note",
    Tools = "tools",
    Help = "help",
    Context = "context",
    NoteListContextMenu = "noteListContextMenu",
    EditorContextMenu = "editorContextMenu",
    FolderContextMenu = "folderContextMenu",
    TagContextMenu = "tagContextMenu",
  }

  export enum ToolbarButtonLocation {
    NoteToolbar = "noteToolbar",
    EditorToolbar = "editorToolbar",
  }
}
