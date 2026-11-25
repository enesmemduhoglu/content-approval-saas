import { describe, expect, it } from "vitest";
import { jpegSize } from "@/lib/jpeg-size";

// Elle kurulmuş en küçük başlıklar: SOI + (APP0) + SOF. Görüntü verisi
// gerekmiyor; okuyucu SOF'ta durur.
function jpeg(segments: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...segments.flat()]);
}
const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
function sof(marker: number, width: number, height: number) {
  return [0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...new Array(9).fill(0)];
}

describe("jpegSize", () => {
  it("baseline (C0) ve progressive (C2) SOF'tan en/boy okur", () => {
    expect(jpegSize(jpeg([app0, sof(0xc0, 2160, 2700)]))).toEqual({ width: 2160, height: 2700 });
    expect(jpegSize(jpeg([sof(0xc2, 1080, 1350)]))).toEqual({ width: 1080, height: 1350 });
  });

  it("segmentler arası dolgu baytlarını atlar", () => {
    expect(jpegSize(jpeg([app0, [0xff], sof(0xc0, 800, 1000)]))).toEqual({ width: 800, height: 1000 });
  });

  it("DHT (C4) SOF sayılmaz", () => {
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
    expect(jpegSize(jpeg([dht, sof(0xc0, 10, 20)]))).toEqual({ width: 10, height: 20 });
  });

  it("JPEG olmayan, kısa, kesik ya da SOF'suz dosyada null", () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(jpegSize(jpeg([app0, [0xff, 0xc0, 0x00]]))).toBeNull();
    expect(jpegSize(jpeg([app0, [0xff, 0xda, 0x00, 0x02]]))).toBeNull();
    expect(jpegSize(jpeg([app0, [0x12, 0x34, 0x56, 0x78]]))).toBeNull();
    expect(jpegSize(jpeg([sof(0xc0, 0, 100)]))).toBeNull();
  });
});
