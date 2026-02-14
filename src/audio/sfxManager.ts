import {
  completedSfxUrl,
  sentSfxUrl,
  thinkingSfxUrl,
  toolCallSfxUrl,
} from "../assets";

export type SfxName = "sent" | "thinking" | "toolCall" | "completed";

const SFX_SOURCES: Record<SfxName, string> = {
  sent: sentSfxUrl,
  thinking: thinkingSfxUrl,
  toolCall: toolCallSfxUrl,
  completed: completedSfxUrl,
};

const SFX_VOLUME = 0.5;

class SfxManager {
  private queue: SfxName[] = [];
  private active = false;

  private playNow(name: SfxName): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }

      const audio = new Audio(SFX_SOURCES[name]);
      audio.preload = "auto";
      audio.volume = SFX_VOLUME;

      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        resolve();
      };

      audio.onended = finalize;
      audio.onerror = finalize;
      void audio.play().catch(() => finalize());
    });
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) continue;
        await this.playNow(next);
      }
    } finally {
      this.active = false;
    }
  }

  playCue(name: SfxName): void {
    if (typeof window === "undefined") return;
    this.queue.push(name);
    if (!this.active) {
      void this.drain();
    }
  }
}

const sfxManager = new SfxManager();

export const playCue = (name: SfxName): void => {
  sfxManager.playCue(name);
};
