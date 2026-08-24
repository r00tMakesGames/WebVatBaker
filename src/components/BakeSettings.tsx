import { useStore } from '../state/store';
import { appStore, updateMatch, updateNaming, updateSettings } from '../state/session';
import {
  bytesPerTexture,
  computeLayout,
  TextureCapacityError,
  WIDTH_OPTIONS,
} from '../vat/VATPacker';
import { estimateBakeMemory, formatBytes } from '../vat/Baker';
import type { VATMode, WidthSetting } from '../vat/types';

export function BakeSettings() {
  const state = useStore(appStore);
  const s = state.settings;
  const vertexCount = state.baseSummary?.vertexCount ?? 0;
  const boneCount = state.baseSummary?.boneCount ?? 0;
  const boneMode = s.vatMode === 'bone';
  const addressed = boneMode ? boneCount : vertexCount;

  let layoutLine = 'Load a character and at least one animation.';
  let layoutError = false;
  let savingLine = '';
  if (addressed > 0 && state.totalFrames > 0) {
    try {
      const layout = computeLayout(addressed, state.totalFrames, s.textureWidth, s.maxTextureDimension);
      const perTexture = bytesPerTexture(layout, s.precision);
      layoutLine =
        `${layout.width} x ${layout.height} · ${layout.usedSamples.toLocaleString()} samples · ` +
        `${layout.wastedSamples.toLocaleString()} padding · ${formatBytes(perTexture)} per EXR · ` +
        `${formatBytes(estimateBakeMemory(vertexCount, state.totalFrames, s.bakeNormals, boneMode ? boneCount : 0))} RAM`;
      if (boneMode && vertexCount > 0) {
        const vertexBytes = vertexCount * state.totalFrames * (s.precision === 'RGBA16F' ? 8 : 16);
        savingLine =
          `Two textures (position + rotation) = ${formatBytes(perTexture * 2)}, ` +
          `versus ${formatBytes(vertexBytes)} in vertex mode — ` +
          `${(vertexBytes / (perTexture * 2)).toFixed(0)}x smaller.`;
      }
    } catch (err) {
      layoutError = true;
      layoutLine = err instanceof TextureCapacityError ? err.message : String(err);
    }
  }

  return (
    <section className="panel panel-settings">
      <header className="panel-head">
        <h2>Bake settings</h2>
      </header>

      <div className="fields">
        <label className="field">
          <span>Asset name</span>
          <input
            value={s.assetName}
            onChange={(e) => updateSettings({ assetName: e.target.value })}
          />
        </label>

        <label className="field">
          <span>VAT mode</span>
          <select
            value={s.vatMode}
            onChange={(e) => updateSettings({ vatMode: e.target.value as VATMode })}
          >
            <option value="vertex">Vertex — one position per vertex per frame</option>
            <option value="bone">Bone — one transform per bone per frame</option>
          </select>
        </label>

        {boneMode && (
          <p className="hint">
            Re-skins in the material at runtime: far smaller textures, but costs per-vertex
            shader work, drops non-uniform bone scale, and requires <em>Use Full Precision
            UVs</em> on import.
          </p>
        )}

        <label className="field">
          <span>Bake FPS</span>
          <input
            type="number"
            min={1}
            max={240}
            step={1}
            value={s.bakeFPS}
            onChange={(e) => updateSettings({ bakeFPS: Math.max(1, Number(e.target.value) || 30) })}
          />
        </label>

        <label className="field" hidden={boneMode}>
          <span>Position mode</span>
          <select
            value={s.positionMode}
            onChange={(e) => updateSettings({ positionMode: e.target.value as 'offset' | 'absolute' })}
          >
            <option value="offset">Object space, offset from rest</option>
            <option value="absolute">Object space, absolute</option>
          </select>
        </label>

        <label className="field">
          <span>Precision</span>
          <select
            value={s.precision}
            onChange={(e) => updateSettings({ precision: e.target.value as 'RGBA16F' | 'RGBA32F' })}
          >
            <option value="RGBA16F">RGBA16F</option>
            <option value="RGBA32F">RGBA32F</option>
          </select>
        </label>

        <label className="field">
          <span>Texture width</span>
          <select
            value={String(s.textureWidth)}
            onChange={(e) =>
              updateSettings({
                textureWidth: (e.target.value === 'auto'
                  ? 'auto'
                  : Number(e.target.value)) as WidthSetting,
              })
            }
          >
            <option value="auto">Auto</option>
            {WIDTH_OPTIONS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Unit scale</span>
          <input
            type="number"
            step={0.01}
            value={s.unitScale}
            onChange={(e) => updateSettings({ unitScale: Number(e.target.value) || 1 })}
          />
        </label>

        <label className="field">
          <span>Lookup split</span>
          <input
            type="number"
            min={64}
            max={2048}
            step={64}
            value={s.lookupSplit}
            onChange={(e) => updateSettings({ lookupSplit: Math.max(64, Number(e.target.value) || 1024) })}
          />
        </label>

        <label className="field">
          <span>Axis conversion</span>
          <select
            value={s.axisConversion}
            onChange={(e) =>
              updateSettings({ axisConversion: e.target.value as 'none' | 'gltf_to_unreal' })
            }
          >
            <option value="none">None (source space)</option>
            <option value="gltf_to_unreal">glTF → Unreal (Z-up)</option>
          </select>
        </label>
      </div>

      <div className="checks">
        <label className="check">
          <input
            type="checkbox"
            checked={s.bakeNormals}
            onChange={(e) => updateSettings({ bakeNormals: e.target.checked })}
          />
          Bake animated normals
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.generateLookupTexture}
            onChange={(e) => updateSettings({ generateLookupTexture: e.target.checked })}
          />
          Animation lookup texture
        </label>
      </div>

      <p className={`layout-line mono${layoutError ? ' is-error' : ''}`}>{layoutLine}</p>
      {savingLine && <p className="layout-line mono is-good">{savingLine}</p>}

      <details className="group">
        <summary>Skeleton matching</summary>
        <div className="checks">
          <label className="check">
            <input
              type="checkbox"
              checked={state.match.stripNamespaces}
              onChange={(e) => updateMatch({ stripNamespaces: e.target.checked })}
            />
            Strip namespaces (mixamorig:, Armature|, …)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.match.stripNonRootTranslation}
              onChange={(e) => updateMatch({ stripNonRootTranslation: e.target.checked })}
            />
            Rotation only below the root
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.match.stripScaleTracks}
              onChange={(e) => updateMatch({ stripScaleTracks: e.target.checked })}
            />
            Drop scale tracks
          </label>
        </div>
        <div className="fields">
          <label className="field">
            <span>Extra namespaces</span>
            <input
              placeholder="comma separated"
              value={state.match.extraNamespaces}
              onChange={(e) => updateMatch({ extraNamespaces: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Root translation scale</span>
            <select
              value={state.match.translationScaleMode}
              onChange={(e) =>
                updateMatch({ translationScaleMode: e.target.value as 'none' | 'auto' | 'manual' })
              }
            >
              <option value="none">1:1</option>
              <option value="auto">Auto from hips height</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          {state.match.translationScaleMode === 'manual' && (
            <label className="field">
              <span>Scale factor</span>
              <input
                type="number"
                step={0.01}
                value={state.match.translationScale}
                onChange={(e) => updateMatch({ translationScale: Number(e.target.value) || 1 })}
              />
            </label>
          )}
        </div>
      </details>

      <details className="group">
        <summary>Naming</summary>
        <div className="fields">
          <label className="field">
            <span>Strip from asset</span>
            <input
              value={state.naming.assetPrefixes}
              onChange={(e) => updateNaming({ assetPrefixes: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Strip from clips</span>
            <input
              value={state.naming.animationPrefixes}
              onChange={(e) => updateNaming({ animationPrefixes: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Strip tokens</span>
            <input
              placeholder="Club_"
              value={state.naming.animationTokens}
              onChange={(e) => updateNaming({ animationTokens: e.target.value })}
            />
          </label>
        </div>
        <p className="note">Naming rules apply to clips imported after the change.</p>
      </details>
    </section>
  );
}
