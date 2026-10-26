/** Installed before generated code in disposable verification frames only.
 * Keep clocks, audio graphs, and playback promises functional while preventing
 * sound from reaching the user. Finished nodes do not install these hooks.
 * Self-contained: serialized into the sandbox document with toString(). */
export function installInteractiveAudioMute(): void {
  const constructors = [window.AudioContext,
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext];
  if (typeof AudioNode !== 'undefined') {
    const connect = AudioNode.prototype.connect;
    const disconnect = AudioNode.prototype.disconnect;
    const outputs = new WeakMap<BaseAudioContext, GainNode>();
    const silentDestination = (node: AudioNode, target: unknown): unknown => {
      const context = node.context;
      // Offline rendering is not audible and must retain its real samples.
      if (target !== context.destination || !constructors.some(Native => Native && context instanceof Native)) return target;
      let output = outputs.get(context);
      if (!output) {
        output = context.createGain();
        output.gain.value = 0;
        Reflect.apply(connect, output, [context.destination]);
        outputs.set(context, output);
      }
      return output;
    };
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const destination = args[0];
      args[0] = silentDestination(this, destination);
      const result = Reflect.apply(connect, this, args);
      // Preserve connect() chaining without exposing the zero-gain output.
      return result === args[0] ? destination : result;
    } as AudioNode['connect'];
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
      if (args.length) args[0] = silentDestination(this, args[0]);
      return Reflect.apply(disconnect, this, args);
    } as AudioNode['disconnect'];
  }

  if (typeof HTMLMediaElement !== 'undefined') {
    const prototype = HTMLMediaElement.prototype;
    const muted = Object.getOwnPropertyDescriptor(prototype, 'muted');
    if (muted?.set) {
      const mute = (media: HTMLMediaElement) => muted.set!.call(media, true);
      // Ignore attempts to unmute, including from a test's simulated clicks.
      Object.defineProperty(prototype, 'muted', { ...muted, set() { mute(this); } });
      const play = prototype.play;
      prototype.play = function () { mute(this); return play.call(this); };
      const autoplay = Object.getOwnPropertyDescriptor(prototype, 'autoplay');
      if (autoplay?.set) Object.defineProperty(prototype, 'autoplay', {
        ...autoplay, set(value: boolean) { mute(this); autoplay.set!.call(this, value); },
      });
      const NativeAudio = window.Audio;
      if (NativeAudio) {
        const MutedAudio = function (this: HTMLAudioElement, ...args: unknown[]) {
          const media = Reflect.construct(NativeAudio, args, new.target || NativeAudio) as HTMLAudioElement;
          mute(media);
          return media;
        } as unknown as typeof Audio;
        Object.setPrototypeOf(MutedAudio, NativeAudio);
        MutedAudio.prototype = NativeAudio.prototype;
        window.Audio = MutedAudio;
      }
      const muteTree = (node: Node) => {
        if (node instanceof HTMLMediaElement) mute(node);
        if (node instanceof Element) node.querySelectorAll<HTMLMediaElement>('audio,video').forEach(mute);
      };
      // Covers parser-created autoplay elements and later DOM insertions.
      muteTree(document.documentElement);
      new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(muteTree)))
        .observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('play', event => {
        if (event.target instanceof HTMLMediaElement) mute(event.target);
      }, true);
    }
  }

  // Speech is a separate browser output, not part of the Web Audio graph.
  // Do not cancel speech globally: another finished node may be using it.
  if (typeof SpeechSynthesis !== 'undefined') {
    const speak = SpeechSynthesis.prototype.speak;
    const volume = Object.getOwnPropertyDescriptor(SpeechSynthesisUtterance.prototype, 'volume');
    if (volume?.set) {
      Object.defineProperty(SpeechSynthesisUtterance.prototype, 'volume', { ...volume,
        set() { volume.set!.call(this, 0); },
      });
      SpeechSynthesis.prototype.speak = function (utterance) {
        utterance.volume = 0;
        return speak.call(this, utterance);
      };
    } else SpeechSynthesis.prototype.speak = function () {};
  }
}
