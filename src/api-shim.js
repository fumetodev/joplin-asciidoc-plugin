// Joplin injects 'joplin' as a global variable in the plugin sandbox.
// This shim allows `import joplin from "api"` to work by re-exporting the global.
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = joplin;
