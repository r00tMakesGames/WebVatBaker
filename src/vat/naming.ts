/** Output-name derivation. Pure string work, no Three.js. */

export function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '');
}

export function splitList(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripLeading(name: string, prefixes: string[]): string {
  let out = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (p && out.toLowerCase().startsWith(p.toLowerCase()) && out.length > p.length) {
        out = out.slice(p.length);
        changed = true;
      }
    }
  }
  return out;
}

export function sanitizeToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Asset';
}

/** `SK_Club_Male01.fbx` + ["SK_"] -> `Club_Male01` */
export function deriveAssetName(filename: string, prefixes: string[]): string {
  return sanitizeToken(stripLeading(stripExtension(filename), prefixes));
}

/** `AN_Club_Dance_A.fbx` + ["AN_"] + ["Club_"] -> `Dance_A` */
export function deriveAnimationName(
  filename: string,
  prefixes: string[],
  tokens: string[],
): string {
  const base = stripExtension(filename);
  return sanitizeToken(stripLeading(stripLeading(base, prefixes), tokens));
}

/** First underscore-separated token of the asset name, e.g. `Club_Male01` -> `Club_` */
export function assetLeadToken(assetName: string): string {
  const i = assetName.indexOf('_');
  return i > 0 ? assetName.slice(0, i + 1) : '';
}

export function outputNames(asset: string) {
  return {
    mesh: `SM_${asset}_VAT.glb`,
    position: `T_${asset}_VAT_Pos.exr`,
    normal: `T_${asset}_VAT_Nrm.exr`,
    bonePosition: `T_${asset}_VAT_BonePos.exr`,
    boneRotation: `T_${asset}_VAT_BoneRot.exr`,
    lookup: `T_${asset}_VAT_Lookup.exr`,
    json: `${asset}_VAT.json`,
    csv: `${asset}_VAT_Animations.csv`,
    report: `${asset}_VAT_Validation.txt`,
  };
}
