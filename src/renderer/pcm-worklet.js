// AudioWorkletProcessor — mixes mic + system audio to mono and posts ~100ms
// chunks back to the main thread. Also reports per-input RMS so the UI can
// show a live level meter.
//
// Has 1 silent output so the graph stays "active" (connected via 0-gain to
// audioCtx.destination on the renderer side). Without this, Chrome will not
// call process() and no audio ever flows.

class MixerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = (options.processorOptions && options.processorOptions.chunkSize) || 4800;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
    // RMS accumulators per chunk
    this.micSumSq = 0;
    this.sysSumSq = 0;
    this.sampleCount = 0;
  }

  process(inputs, outputs) {
    const mic = inputs[0] && inputs[0][0];
    const sys = inputs[1] && inputs[1][0];
    const frames = (mic && mic.length) || (sys && sys.length) || 128;

    for (let i = 0; i < frames; i++) {
      const a = mic ? mic[i] : 0;
      const b = sys ? sys[i] : 0;
      let s = (a + b) * 0.5;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.buffer[this.offset++] = s;

      this.micSumSq += a * a;
      this.sysSumSq += b * b;
      this.sampleCount++;

      if (this.offset >= this.chunkSize) {
        const micRms = Math.sqrt(this.micSumSq / Math.max(1, this.sampleCount));
        const sysRms = Math.sqrt(this.sysSumSq / Math.max(1, this.sampleCount));
        this.port.postMessage({
          pcm: this.buffer.slice(0, this.offset),
          micRms,
          sysRms,
        });
        this.offset = 0;
        this.micSumSq = 0;
        this.sysSumSq = 0;
        this.sampleCount = 0;
      }
    }

    // Output silence on the single output so the node is considered active.
    // outputs[0][0] is already a zero-filled Float32Array, no need to fill it.
    return true;
  }
}

registerProcessor('mixer-processor', MixerProcessor);
