import type { BakeResult } from './types';

export interface VATMetadata {
  version: number;
  generator: string;
  generatedAt: string;
  asset: string;
  mode: 'vertex' | 'bone';
  vertexCount: number;
  totalFrames: number;
  bakeFPS: number;
  positionMode: 'absolute' | 'offset';
  axisConversion: 'none' | 'gltf_to_unreal';
  unitScale: number;
  texture: {
    width: number;
    height: number;
    format: string;
    addressing: 'linear';
    /** literal formula, so the consuming engine never has to guess */
    address: string;
    unusedTexels: number;
  };
  lookup: {
    attribute: string;
    split: number;
    decode: string;
  };
  normals: {
    baked: boolean;
    encoding: string;
  } | null;
  bone: {
    boneCount: number;
    boneNames: string[];
    weightScale: number;
    influences: number;
    rotationTexture: string;
    positionTexture: string;
    address: string;
    decodeInfluence: string;
    skinFormula: string;
    maxScaleDeviation: number;
    maxReconstructionError: number;
    boneTranslationRange: {
      min: [number, number, number];
      max: [number, number, number];
      size: [number, number, number];
    };
  } | null;
  animationLookupTexture: {
    width: number;
    height: number;
    format: string;
    channels: string;
  } | null;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  storedValueRange: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  animations: {
    index: number;
    name: string;
    startFrame: number;
    endFrame: number;
    frameCount: number;
    fps: number;
    duration: number;
    loop: boolean;
    sourceFilename: string;
  }[];
}

const round = (n: number, places = 5) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const roundVec = (v: [number, number, number]) =>
  [round(v[0]), round(v[1]), round(v[2])] as [number, number, number];

export function buildMetadata(result: BakeResult): VATMetadata {
  const s = result.settings;
  return {
    version: 1,
    generator: 'VAT Baker 1.0',
    generatedAt: new Date().toISOString(),
    asset: s.assetName,
    mode: s.vatMode,
    vertexCount: result.vertexCount,
    totalFrames: result.totalFrames,
    bakeFPS: s.bakeFPS,
    positionMode: s.positionMode,
    axisConversion: s.axisConversion,
    unitScale: s.unitScale,
    texture: {
      width: result.layout.width,
      height: result.layout.height,
      format: s.precision,
      addressing: 'linear',
      address: result.bone
        ? 'linearSample = globalFrame * boneCount + boneIndex; ' +
          'x = linearSample % width; y = floor(linearSample / width)'
        : 'linearSample = globalFrame * vertexCount + vertexIndex; ' +
          'x = linearSample % width; y = floor(linearSample / width)',
      unusedTexels: result.layout.wastedSamples,
    },
    lookup: result.bone
      ? {
          attribute: 'TEXCOORD_1 + TEXCOORD_2',
          split: 0,
          decode:
            'bone mode does not address the texture per vertex; ' +
            'TEXCOORD_1/2 carry packed skin influences instead (see "bone")',
        }
      : {
          attribute: 'TEXCOORD_1',
          split: s.lookupSplit,
          decode: `vertexIndex = round(uv1.x) + round(uv1.y) * ${s.lookupSplit}`,
        },
    bone: result.bone
      ? {
          boneCount: result.bone.boneCount,
          boneNames: result.bone.boneNames,
          weightScale: 0.99,
          influences: 4,
          positionTexture: 'RGB = translation of B_k, A = 1',
          rotationTexture: 'RGBA = quaternion (x,y,z,w) of B_k',
          address:
            'linearSample = globalFrame * boneCount + boneIndex; ' +
            'x = linearSample % width; y = floor(linearSample / width)',
          decodeInfluence:
            'packed = (uv1.x, uv1.y, uv2.x, uv2.y); ' +
            'boneIndex = floor(packed); weight = frac(packed) / 0.99',
          skinFormula:
            'P_anim = sum_k w_k * ( quatRotate(rot_k, P_rest) + pos_k ) / sum_k w_k; ' +
            'N_anim = normalize( sum_k w_k * quatRotate(rot_k, N_rest) )',
          maxScaleDeviation: round(result.bone.maxScaleDeviation, 6),
          maxReconstructionError: round(result.bone.maxReconstructionError, 6),
          boneTranslationRange: {
            min: roundVec(result.bone.bounds.min),
            max: roundVec(result.bone.bounds.max),
            size: roundVec(result.bone.bounds.size),
          },
        }
      : null,
    normals: result.normals
      ? {
          baked: true,
          encoding:
            'unit-length object-space normal stored raw in RGB, range -1..1, alpha 1. ' +
            'Not offset-encoded even when positionMode is offset.',
        }
      : null,
    animationLookupTexture: result.lookupTexture
      ? {
          width: result.lookupTexture.width,
          height: result.lookupTexture.height,
          format: 'RGBA32F',
          channels: 'R=StartFrame G=FrameCount B=FPS A=Flags(bit0=loop)',
        }
      : null,
    bounds: {
      min: roundVec(result.bounds.min),
      max: roundVec(result.bounds.max),
      size: roundVec(result.bounds.size),
    },
    storedValueRange: {
      min: roundVec(result.storedBounds.min),
      max: roundVec(result.storedBounds.max),
      size: roundVec(result.storedBounds.size),
    },
    animations: result.ranges.map((r) => ({
      index: r.index,
      name: r.name,
      startFrame: r.startFrame,
      endFrame: r.endFrame,
      frameCount: r.frameCount,
      fps: r.fps,
      duration: round(r.duration, 6),
      loop: r.loop,
      sourceFilename: r.sourceFilename,
    })),
  };
}

export function metadataToJSON(meta: VATMetadata): string {
  return JSON.stringify(meta, null, 4);
}

const CSV_COLUMNS = [
  'Index',
  'Name',
  'StartFrame',
  'EndFrame',
  'FrameCount',
  'FPS',
  'Duration',
  'Loop',
  'SourceFilename',
];

function csvCell(value: string | number | boolean): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Unreal DataTable friendly: one row per animation, stable column order. */
export function metadataToCSV(meta: VATMetadata): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const a of meta.animations) {
    lines.push(
      [
        a.index,
        a.name,
        a.startFrame,
        a.endFrame,
        a.frameCount,
        a.fps,
        a.duration,
        a.loop ? 'True' : 'False',
        a.sourceFilename,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
