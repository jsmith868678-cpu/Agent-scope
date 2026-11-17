class SoundEngine {
  private ctx: AudioContext | null = null;
  muted = false;

  private ensureCtx(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private tone(freq: number, endFreq: number, duration: number, type: OscillatorType, gainVal: number): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    const jitter = 0.94 + Math.random() * 0.12;
    osc.frequency.setValueAtTime(freq * jitter, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq * jitter), now + duration);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  playJump(): void {
    this.tone(240, 520, 0.11, 'triangle', 0.08);
  }

  playPlate(): void {
    this.tone(420, 620, 0.09, 'sine', 0.07);
  }

  playSwitch(): void {
    this.tone(320, 680, 0.12, 'square', 0.045);
  }

  playDoorOpen(): void {
    this.tone(260, 440, 0.18, 'triangle', 0.07);
  }

  playRespawn(): void {
    this.tone(300, 110, 0.22, 'sawtooth', 0.06);
  }

  playSolved(): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const notes = [440, 554.37, 659.25, 880];
    notes.forEach((n, idx) => {
      setTimeout(() => {
        this.tone(n, n * 1.02, 0.22, 'triangle', 0.08);
      }, idx * 80);
    });
  }
}

export const soundFX = new SoundEngine();
