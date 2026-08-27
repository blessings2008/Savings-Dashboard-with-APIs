// PocketVault device fingerprint — referral abuse detection.
//
// Not a general anti-fraud or session-security mechanism — its only
// purpose is giving checkReferralCompletion() (helpers.js) a signal
// to compare between a referrer and the person they referred, so an
// obvious same-device self-referral can be flagged for admin review
// instead of auto-paying out. It is deliberately NOT cryptographically
// strong or resistant to a determined attacker clearing storage/using
// a different browser — that's an acceptable gap given the mitigation
// is "flag for human review," not "hard block."
//
// Combines a canvas render hash (varies by GPU/driver/font rendering,
// a well-established lightweight fingerprint signal) with coarse
// navigator/screen properties. No new dependency — built from
// scratch since installing a fingerprinting library isn't available
// in this environment.
function canvasHash() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-canvas";
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#00e5a0";
    ctx.fillRect(0, 0, 220, 30);
    ctx.fillStyle = "#000";
    ctx.fillText("PocketVault fp 🔒", 2, 2);
    const dataUrl = canvas.toDataURL();
    // Simple string hash (not cryptographic — doesn't need to be,
    // this only needs to be stable per-device and roughly unique,
    // not tamper-proof)
    let hash = 0;
    for (let i = 0; i < dataUrl.length; i++) {
      hash = ((hash << 5) - hash + dataUrl.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  } catch {
    return "canvas-error";
  }
}

export function getDeviceFingerprint() {
  const parts = [
    canvasHash(),
    navigator.userAgent || "",
    navigator.language || "",
    String(screen.width) + "x" + String(screen.height),
    String(screen.colorDepth || ""),
    Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    String(navigator.hardwareConcurrency || ""),
  ];
  const raw = parts.join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return "fp_" + Math.abs(hash).toString(36);
}
