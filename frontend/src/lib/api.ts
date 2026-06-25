export const API_BASE = import.meta.env.VITE_API_BASE || "";


/** Extrait la première URL plausible d’un texte, sinon renvoie le 1er mot trim */
export const pickUrlLike = (raw: string): string => {
  const t = (raw || "").trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0];
  const first = t.split(/\s+/)[0] ?? "";
  if (
    /^(?:www\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|open\.spotify\.com|twitch\.tv|clips\.twitch\.tv)\//i.test(
      first
    ) ||
    /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(first)
  ) {
    return `https://${first}`;
  }
  return first;
};
