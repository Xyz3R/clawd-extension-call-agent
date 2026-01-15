import wavefile from "wavefile";

export function transcodePcm24ToPcmu8(buf: Buffer): Buffer {
  // Input: 16-bit little-endian PCM @ 24kHz. Output: 8-bit mu-law PCM @ 8kHz.
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  if (!samples.length) return Buffer.alloc(0);

  const wav = new wavefile.WaveFile();
  wav.fromScratch(1, 24000, "16", samples);
  wav.toSampleRate(8000, { method: "sinc" });
  wav.toMuLaw();
  const data = wav.data as { samples: Uint8Array };
  return Buffer.from(data.samples);
}
