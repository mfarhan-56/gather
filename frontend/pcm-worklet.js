// AudioWorklet: downsample to 16 kHz mono PCM16 and post ~50 ms chunks + a level meter value.
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.chunk = new Int16Array(800); // 50 ms @ 16 kHz
    this.n = 0;
    this.pos = 0; // fractional read position carried across blocks
    this.acc = 0;
    this.accN = 0;
    this.peak = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const chs = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      v /= chs;
      // box-filter decimation: average all source samples belonging to one output sample
      this.acc += v;
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        s = Math.max(-1, Math.min(1, s));
        const a = Math.abs(s);
        if (a > this.peak) this.peak = a;
        this.chunk[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.chunk.length) {
          this.port.postMessage({ pcm: this.chunk.buffer, level: this.peak }, [this.chunk.buffer]);
          this.chunk = new Int16Array(800);
          this.n = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-worklet", PCMWorklet);
