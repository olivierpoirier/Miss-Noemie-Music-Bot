import { cn } from "../lib/cn";

interface Props {
  isOpen: boolean;
  message?: string | null;
  rainbow?: boolean;
  onShowDiagnostics?: () => void;
}

export default function SystemAlert({ isOpen, message, rainbow, onShowDiagnostics }: Props) {
  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[10000] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm",
        rainbow && "rainbow-cycle"
      )}
    >
      <div
        className={cn(
          "max-w-md w-full p-8 rounded-2xl border-4 text-center shadow-2xl",
          rainbow
            ? "bg-black text-white border-pink-500 shadow-pink-500/20 rainbow-cycle"
            : "bg-bg text-ink border-white/20 shadow-black/20"
        )}
      >
        <div className="text-4xl mb-4">Avertissement</div>
        <h2 className="text-xl font-black uppercase tracking-tighter mb-2">
          Entree audio virtuelle requise
        </h2>
        <p className="text-sm opacity-80 font-mono mb-6">
          {message || "Le serveur n'a pas d'entree audio virtuelle prete."}
        </p>

        <a
          href="https://vb-audio.com/Voicemeeter/banana.htm"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-block w-full py-3 px-6 rounded-xl font-bold uppercase tracking-widest transition-transform active:scale-95",
            rainbow ? "bg-pink-500 text-white rainbow-cycle" : "bg-white text-black"
          )}
        >
          Configurer VoiceMeeter
        </a>

        {onShowDiagnostics && (
          <button
            type="button"
            onClick={onShowDiagnostics}
            className="mt-3 w-full rounded-xl border border-white/30 px-6 py-3 font-semibold transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Voir le diagnostic
          </button>
        )}

        <p className="mt-4 text-[10px] uppercase opacity-50 italic">
          La lecture reste bloquée jusqu’au rétablissement du routage audio.
        </p>
      </div>
    </div>
  );
}
