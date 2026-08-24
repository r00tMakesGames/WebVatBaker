/**
 * Minimal, dependency-free OpenEXR writer.
 *
 * Writes a single-part, scanline, UNCOMPRESSED RGBA image with either HALF or
 * FLOAT channels. Uncompressed is deliberate: the files are intermediate
 * production data, and every engine reads NO_COMPRESSION scanline EXR.
 *
 * Layout produced:
 *   magic (0x01312F76) | version 2 | header attributes | 0x00
 *   scanline offset table (uint64 * height)
 *   per scanline: int32 y | int32 byteCount | channel data (A, B, G, R)
 *
 * EXR requires channels to be listed and stored in alphabetical order, hence
 * A, B, G, R rather than R, G, B, A.
 */

export type EXRPixelType = 'half' | 'float';

const HALF_MAX = 65504;
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

/** IEEE-754 binary32 -> binary16 with round-to-nearest-even. */
export function toHalf(value: number): number {
  let v = value;
  if (!Number.isFinite(v)) v = 0;
  if (v > HALF_MAX) v = HALF_MAX;
  else if (v < -HALF_MAX) v = -HALF_MAX;

  _f32[0] = v;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;

  if (e < 103) return bits; // underflow to signed zero
  if (e > 142) return bits | 0x7c00; // clamped above, so this is +/-inf only
  if (e < 113) {
    m |= 0x0800;
    bits += (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

class ByteList {
  readonly bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  i32(v: number) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  f32(v: number) {
    _f32[0] = v;
    this.i32(_i32[0]);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i) & 0xff);
  }
  nullStr(s: string) {
    this.str(s);
    this.bytes.push(0);
  }
  append(other: ByteList) {
    for (let i = 0; i < other.bytes.length; i++) this.bytes.push(other.bytes[i]);
  }
}

function attribute(h: ByteList, name: string, type: string, payload: ByteList) {
  h.nullStr(name);
  h.nullStr(type);
  h.i32(payload.bytes.length);
  h.append(payload);
}

/** File-order channel names. Must stay alphabetical. */
const CHANNELS = ['A', 'B', 'G', 'R'] as const;
/** Index into an interleaved RGBA source for each file-order channel. */
const SOURCE_OFFSET = [3, 2, 1, 0];

export interface EXRWriteOptions {
  pixelType: EXRPixelType;
  /** Optional per-component linear transform applied on write (axis conversion). */
  transform?: ((x: number, y: number, z: number, out: Float32Array) => void) | null;
}

/**
 * @param rgba interleaved RGBA float data, length must be width*height*4
 */
export function writeEXR(
  rgba: Float32Array,
  width: number,
  height: number,
  options: EXRWriteOptions,
): ArrayBuffer {
  if (rgba.length < width * height * 4) {
    throw new Error(
      `writeEXR: buffer too small (${rgba.length} < ${width * height * 4})`,
    );
  }

  const isHalf = options.pixelType === 'half';
  const bytesPerSample = isHalf ? 2 : 4;
  const pixelTypeCode = isHalf ? 1 : 2; // 0 UINT, 1 HALF, 2 FLOAT

  // ---- header -------------------------------------------------------------
  const h = new ByteList();
  h.i32(20000630); // 0x01312F76
  h.i32(2); // version 2, no flags -> single part scanline

  const chlist = new ByteList();
  for (const c of CHANNELS) {
    chlist.nullStr(c);
    chlist.i32(pixelTypeCode);
    chlist.u8(0); // pLinear
    chlist.u8(0);
    chlist.u8(0);
    chlist.u8(0); // reserved
    chlist.i32(1); // xSampling
    chlist.i32(1); // ySampling
  }
  chlist.u8(0); // end of channel list
  attribute(h, 'channels', 'chlist', chlist);

  const compression = new ByteList();
  compression.u8(0); // NO_COMPRESSION
  attribute(h, 'compression', 'compression', compression);

  const box = new ByteList();
  box.i32(0);
  box.i32(0);
  box.i32(width - 1);
  box.i32(height - 1);
  attribute(h, 'dataWindow', 'box2i', box);
  attribute(h, 'displayWindow', 'box2i', box);

  const lineOrder = new ByteList();
  lineOrder.u8(0); // INCREASING_Y
  attribute(h, 'lineOrder', 'lineOrder', lineOrder);

  const par = new ByteList();
  par.f32(1);
  attribute(h, 'pixelAspectRatio', 'float', par);

  const swc = new ByteList();
  swc.f32(0);
  swc.f32(0);
  attribute(h, 'screenWindowCenter', 'v2f', swc);

  const sww = new ByteList();
  sww.f32(1);
  attribute(h, 'screenWindowWidth', 'float', sww);

  h.u8(0); // end of header

  const headerBytes = h.bytes.length;
  const offsetTableBytes = height * 8;
  const scanlineBytes = width * CHANNELS.length * bytesPerSample;
  const chunkBytes = 8 + scanlineBytes;
  const total = headerBytes + offsetTableBytes + height * chunkBytes;

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  u8.set(Uint8Array.from(h.bytes), 0);

  // ---- offset table -------------------------------------------------------
  let cursor = headerBytes + offsetTableBytes;
  for (let y = 0; y < height; y++) {
    view.setUint32(headerBytes + y * 8, cursor >>> 0, true);
    view.setUint32(headerBytes + y * 8 + 4, Math.floor(cursor / 4294967296), true);
    cursor += chunkBytes;
  }

  // ---- scanlines ----------------------------------------------------------
  const xf = options.transform ?? null;
  const tmp = new Float32Array(3);
  let write = headerBytes + offsetTableBytes;

  for (let y = 0; y < height; y++) {
    view.setInt32(write, y, true);
    view.setInt32(write + 4, scanlineBytes, true);
    let p = write + 8;

    // Optional axis conversion is a per-pixel operation on XYZ, so pre-resolve
    // the row into a scratch buffer once instead of once per channel.
    const rowBase = y * width * 4;
    let row = rgba;
    let rowOffset = rowBase;
    if (xf) {
      row = _scratchRow(width);
      for (let x = 0; x < width; x++) {
        const s = rowBase + x * 4;
        xf(rgba[s], rgba[s + 1], rgba[s + 2], tmp);
        const d = x * 4;
        row[d] = tmp[0];
        row[d + 1] = tmp[1];
        row[d + 2] = tmp[2];
        row[d + 3] = rgba[s + 3];
      }
      rowOffset = 0;
    }

    for (let c = 0; c < CHANNELS.length; c++) {
      const off = SOURCE_OFFSET[c];
      if (isHalf) {
        for (let x = 0; x < width; x++) {
          view.setUint16(p, toHalf(row[rowOffset + x * 4 + off]), true);
          p += 2;
        }
      } else {
        for (let x = 0; x < width; x++) {
          view.setFloat32(p, row[rowOffset + x * 4 + off], true);
          p += 4;
        }
      }
    }
    write += chunkBytes;
  }

  return buffer;
}

let _scratch: Float32Array | null = null;
function _scratchRow(width: number): Float32Array {
  if (!_scratch || _scratch.length < width * 4) _scratch = new Float32Array(width * 4);
  return _scratch;
}

/** glTF/Three (Y-up, RH) -> Unreal (Z-up, LH). Matches the UE glTF importer basis. */
export function gltfToUnreal(x: number, y: number, z: number, out: Float32Array) {
  out[0] = -z;
  out[1] = x;
  out[2] = y;
}
