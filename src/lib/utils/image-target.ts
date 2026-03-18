const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function hasUriScheme(target: string) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target);
}

function fileUrlToPath(target: string) {
  try {
    const url = new URL(target);
    return decodeURIComponent(url.pathname);
  } catch {
    return target.replace(/^file:\/\//, "");
  }
}

export function isLocalImageTarget(target: string) {
  const trimmed = target.trim();
  if (!trimmed) return false;
  // Joplin resource references (:/resourceId) are local resources
  if (/^:\/?[a-f0-9]{32}/.test(trimmed)) return true;
  return trimmed.startsWith("/") || trimmed.startsWith("file://") || WINDOWS_ABSOLUTE_PATH.test(trimmed);
}

export function isJoplinResource(target: string): boolean {
  return /^:\/?[a-f0-9]{32}/.test(target.trim());
}

export function normalizeImageTarget(target: string) {
  const trimmed = target.trim();
  if (!trimmed) return "";

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:")
  ) {
    return trimmed;
  }

  if (!isLocalImageTarget(trimmed) && hasUriScheme(trimmed)) {
    return trimmed;
  }

  if (!isLocalImageTarget(trimmed)) {
    return trimmed;
  }

  // In Joplin context, just return the local path as-is (no Tauri convertFileSrc)
  const localPath = trimmed.startsWith("file://") ? fileUrlToPath(trimmed) : trimmed;
  return localPath;
}

export function deriveImageAlt(target: string) {
  const normalized = target.trim().startsWith("file://") ? fileUrlToPath(target.trim()) : target.trim();
  const fileName = normalized.split(/[\\/]/).pop() || "image";
  const decoded = (() => {
    try {
      return decodeURIComponent(fileName);
    } catch {
      return fileName;
    }
  })();
  return decoded.replace(/\.[^.]+$/, "") || "image";
}
