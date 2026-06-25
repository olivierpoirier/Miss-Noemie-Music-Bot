import { Info, Link2, Search, Youtube, Music2, History, MonitorPlay } from "lucide-react";

import type { ThemeName } from "../lib/themes";
import { cn } from "../lib/cn";
import ThemedPanel from "./ui/ThemedPanel";

type Props = {
  theme: ThemeName;
  rainbow?: boolean;
};

export default function SupportedLinksHelp({
  theme,
  rainbow = false,
}: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";
  const iconClass = isAdventurer ? "text-[#d8d0bb]/80" : "text-[var(--c1)]";

  return (
    <ThemedPanel theme={theme} rainbow={rainbow} className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <Info className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
        <span className={cn("font-semibold", rainbow && "rainbow-cycle")}>
          Quels liens vers des audios que ce bot peut utiliser ?
        </span>
      </div>

      <div className="space-y-3 text-sm">
        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <Youtube className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>YouTube</span>
          </div>
          <div className="opacity-85 space-y-1">
            <div>• vidéo YouTube</div>
            <div>• playlist YouTube</div>
            <div>• lien youtu.be</div>
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <Music2 className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>SoundCloud</span>
          </div>
          <div className="opacity-85 space-y-1">
            <div>â€¢ titre SoundCloud</div>
            <div>â€¢ set / playlist SoundCloud</div>
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <Music2 className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>Spotify</span>
          </div>
          <div className="opacity-85 space-y-1">
            <div>• titre Spotify</div>
            <div>• album Spotify</div>
            <div>• certaines playlists Spotify</div>
            <div className="opacity-70">
              Certaines radios ou playlists dynamiques Spotify peuvent ne pas
              être lisibles.
            </div>
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <MonitorPlay className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>Twitch et liens directs</span>
          </div>
          <div className="opacity-85 space-y-1">
            <div>â€¢ live, VOD et clips Twitch</div>
            <div>â€¢ fichiers ou flux audio publics : MP3, AAC, M3U8, FLAC, etc.</div>
            <div className="opacity-70">
              Les sites protÃ©gÃ©s par une connexion ou un DRM restent limitÃ©s par
              leurs propres droits d&apos;accÃ¨s.
            </div>
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <Search className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>Recherche texte</span>
          </div>
          <div className="opacity-85">
            Tu peux écrire directement le nom d’une musique ou d’un artiste
            sans coller de lien. Le bot fera une recherche automatiquement.
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <History className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>Musiques précédentes</span>
          </div>
          <div className="opacity-85">
            Tu peux cliquer sur <strong>+</strong> pour réajouter une musique à
            la file, ou la glisser directement dans la section{" "}
            <strong>File d’attente</strong>.
          </div>
        </ThemedPanel>

        <ThemedPanel theme={theme} rainbow={rainbow} soft className="p-3">
          <div className="flex items-center gap-2 mb-2 font-semibold">
            <Link2 className={cn("w-4 h-4", iconClass, rainbow && "rainbow-cycle")} />
            <span>Conseil</span>
          </div>
          <div className="opacity-85">
            Si un lien ne fonctionne pas, essaie soit un lien YouTube direct,
            soit le nom de la musique en recherche texte.
          </div>
        </ThemedPanel>
      </div>
    </ThemedPanel>
  );
}
