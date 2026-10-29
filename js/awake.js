// Keeps the screen on during a walk, because browsers stop GPS once the phone locks.
//
// 1. The Screen Wake Lock API, re-requested whenever the phone drops it (it does
//    when the app is hidden, and sometimes in Low Power Mode).
// 2. On iPhone, and anywhere Wake Lock is missing or refused, a tiny silent video
//    looping out of sight. A playing video keeps the screen on; it's the
//    long-standing workaround for iOS home-screen apps, where Wake Lock has been
//    unreliable. It's muted, so it never interrupts your music or podcasts.

// 4 seconds of 16x16 black, 1 frame per second, no sound (1.5 KB). Embedded so
// it works offline and isn't affected by how phones fetch video in pieces.
const KEEP_AWAKE_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMzbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAl10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAAAAABAAAAAAHVbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABgG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUBzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PEyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAVSAAAFUgAAABhzdHRzAAAAAAAAAAEAAAAEAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAEAAAAAQAAACRzdHN6AAAAAAAAAAAAAAAEAAACiQAAAAsAAAALAAAACgAAABRzdGNvAAAAAAAAAAEAAANjAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAArFtZGF0AAACcgYF//9u3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOi0zOi0zIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0yLjAwOjAuNzAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS00IHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4yMACAAAAAD2WIhAXzn///D0UAAVefgAAAAAdBmjgL5zqAAAAAB0GaVAL5zqAAAAAGQZpgF851';

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class KeepAwake {
  constructor({ videoSrc = KEEP_AWAKE_VIDEO } = {}) {
    this.videoSrc = videoSrc;
    this.wanted = false;
    this.lock = null;
    this.video = null;
    this.onVisible = () => { if (this.wanted && document.visibilityState === 'visible') this._acquire(); };
  }

  // Call from a tap (starting a walk) so the video is allowed to play.
  async start() {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    await this._acquire();
  }

  stop() {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.lock?.release().catch(() => {});
    this.lock = null;
    if (this.video) {
      this.video.pause();
      this.video.remove();
      this.video = null;
    }
  }

  // 'wake-lock', 'video', 'both' or 'none' — for the status line and debugging.
  get method() {
    const lock = !!this.lock && !this.lock.released;
    const video = !!this.video && !this.video.paused;
    return lock && video ? 'both' : lock ? 'wake-lock' : video ? 'video' : 'none';
  }

  async _acquire() {
    let locked = false;
    if (navigator.wakeLock && (!this.lock || this.lock.released)) {
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => {
          // Dropped by the phone while we still want it: ask again once visible.
          if (this.wanted && document.visibilityState === 'visible') setTimeout(() => this._acquire(), 1000);
        });
        locked = true;
      } catch {
        this.lock = null;
      }
    } else if (this.lock && !this.lock.released) {
      locked = true;
    }
    if (!locked || isIOS()) await this._playVideo();
  }

  async _playVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      Object.assign(v, { src: this.videoSrc, muted: true, loop: true, playsInline: true, autoplay: true });
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      // Must stay in the page and "visible" to count, so just make it tiny and see-through.
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(v);
      this.video = v;
    }
    try { await this.video.play(); } catch { /* blocked until the next tap */ }
  }
}
