/**
 * Getting a record OFF the device.
 *
 * Everything this app measures lives in one browser's localStorage, capped and trimmed. Until this
 * existed there was no way to keep a clinical record past a cleared cache, a re-imaged tablet or the
 * retention limit — which makes it a log, not a record. Two routes, because clinics differ: a file to
 * save (or AirDrop, or attach), and the clipboard for pasting into whatever the notes actually live in.
 *
 * Both are deliberately dumb and DOM-only: no network, nothing leaves the device except by the
 * therapist's own hand.
 */

/** Save `text` as a file the therapist can keep. Returns false when the browser refused. */
export function saveTextFile(filename: string, text: string, mime = 'text/plain'): boolean {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick: revoking synchronously races the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch (err) {
    console.warn('[export] could not save the file', err);
    return false;
  }
}

/**
 * Copy `text` to the clipboard. Returns false when the browser refused (an insecure origin, a denied
 * permission, or a headless context) so the caller can say so instead of claiming a copy that never
 * happened.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
