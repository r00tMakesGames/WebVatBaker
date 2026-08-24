import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createVATMaterial } from '../shaders/vatPreview';
import { makeDataTexture } from '../vat/Baker';
import { WEIGHT_SCALE } from '../vat/BoneEvaluator';
import type { BakeResult } from '../vat/types';

export type PreviewMode = 'skeletal' | 'vat' | 'both';

export interface VATPreviewPayload {
  result: BakeResult;
  geometry: THREE.BufferGeometry;
}

/**
 * Owns the WebGL context. Deliberately outside React: the render loop must not
 * be tied to the reconciler, and Three objects should never live in state.
 */
export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);

  private renderer: THREE.WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private container: HTMLElement | null = null;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private lastTime = 0;

  private grid: THREE.GridHelper | null = null;
  private characterRoot: THREE.Object3D | null = null;
  private skeletonHelper: THREE.SkeletonHelper | null = null;

  private vatGroup = new THREE.Group();
  private vatMesh: THREE.Mesh | null = null;
  private vatMaterial: THREE.RawShaderMaterial | null = null;
  private positionTexture: THREE.DataTexture | null = null;
  private normalTexture: THREE.DataTexture | null = null;
  private rotationTexture: THREE.DataTexture | null = null;

  private mode: PreviewMode = 'skeletal';

  /** Called once per animation frame with the elapsed seconds. */
  onFrame: ((dt: number) => void) | null = null;
  /** Suspended while a bake is running so the baker owns the skeleton. */
  tickEnabled = true;

  constructor() {
    this.scene.background = new THREE.Color(0x0d1013);
    this.scene.add(this.vatGroup);

    const hemi = new THREE.HemisphereLight(0xa8c6ff, 0x1a1d22, 1.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x66ccff, 0.6);
    rim.position.set(-4, 2, -5);
    this.scene.add(rim);

    this.camera.position.set(180, 160, 260);
  }

  mount(container: HTMLElement): void {
    if (this.container === container) return;
    this.container = container;

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    if (!this.controls) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.start();
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.renderer && this.container?.contains(this.renderer.domElement)) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.container = null;
  }

  get maxTextureSize(): number {
    if (!this.renderer) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      return gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192;
    }
    return this.renderer.capabilities.maxTextureSize;
  }

  private resize(): void {
    if (!this.renderer || !this.container) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private start(): void {
    if (this.raf) return;
    this.lastTime = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.25);
      this.lastTime = now;
      if (this.tickEnabled) this.onFrame?.(dt);
      this.controls?.update();
      this.renderer?.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setCharacter(root: THREE.Object3D | null, bounds: THREE.Box3 | null): void {
    if (this.characterRoot) this.scene.remove(this.characterRoot);
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
    }
    this.characterRoot = root;
    if (root) {
      this.scene.add(root);
      const helper = new THREE.SkeletonHelper(root);
      helper.visible = false;
      this.skeletonHelper = helper;
      this.scene.add(helper);
    }
    if (bounds) this.frameBounds(bounds);
  }

  setSkeletonVisible(visible: boolean): void {
    if (this.skeletonHelper) this.skeletonHelper.visible = visible;
  }

  setGridVisible(visible: boolean, size = 200): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }
    if (visible) {
      const divisions = 20;
      const grid = new THREE.GridHelper(size, divisions, 0x3a4450, 0x1e242b);
      (grid.material as THREE.Material).depthWrite = false;
      this.grid = grid;
      this.scene.add(grid);
    }
  }

  frameBounds(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const distance = radius / Math.tan((this.camera.fov * Math.PI) / 360) / 0.55;

    this.camera.near = Math.max(radius / 1000, 0.001);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(
      center.x + distance * 0.6,
      center.y + radius * 0.4,
      center.z + distance * 0.85,
    );
    if (this.controls) {
      this.controls.target.copy(center);
      this.controls.update();
    }
    this.setGridVisible(true, Math.ceil(radius * 4));
  }

  /** Build (or rebuild) the VAT-driven preview mesh from a bake result. */
  setVATPreview(payload: VATPreviewPayload | null): void {
    this.disposeVAT();
    if (!payload) return;

    const { result, geometry } = payload;
    this.positionTexture = makeDataTexture(
      result.positions,
      result.layout.width,
      result.layout.height,
    );
    this.normalTexture = result.normals
      ? makeDataTexture(result.normals, result.layout.width, result.layout.height)
      : null;
    this.rotationTexture = result.bone
      ? makeDataTexture(result.bone.rotations, result.layout.width, result.layout.height)
      : null;

    this.vatMaterial = createVATMaterial({
      positionTexture: this.positionTexture,
      normalTexture: this.normalTexture,
      texWidth: result.layout.width,
      vertexCount: result.vertexCount,
      lookupSplit: result.settings.lookupSplit,
      positionMode: result.settings.positionMode,
      color: 0x9fb4c7,
      wireframe: false,
      mode: result.bone ? 'bone' : 'vertex',
      rotationTexture: this.rotationTexture,
      boneCount: result.bone?.boneCount ?? 1,
      weightScale: WEIGHT_SCALE,
    });

    const mesh = new THREE.Mesh(geometry, this.vatMaterial);
    mesh.frustumCulled = false;
    // VAT space already contains unitScale; undo it so the VAT mesh overlays
    // the skeletal preview exactly.
    const inv = 1 / (result.settings.unitScale || 1);
    mesh.scale.setScalar(inv);
    this.vatMesh = mesh;
    this.vatGroup.add(mesh);
    this.applyMode();
  }

  private disposeVAT(): void {
    if (this.vatMesh) {
      this.vatGroup.remove(this.vatMesh);
      this.vatMesh = null;
    }
    this.vatMaterial?.dispose();
    this.vatMaterial = null;
    this.positionTexture?.dispose();
    this.positionTexture = null;
    this.normalTexture?.dispose();
    this.normalTexture = null;
    this.rotationTexture?.dispose();
    this.rotationTexture = null;
  }

  get hasVAT(): boolean {
    return this.vatMesh !== null;
  }

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    const showSkeletal = this.mode === 'skeletal' || this.mode === 'both';
    const showVAT = (this.mode === 'vat' || this.mode === 'both') && !!this.vatMesh;
    if (this.characterRoot) this.characterRoot.visible = showSkeletal;
    if (this.vatMesh) {
      this.vatMesh.visible = showVAT;
      if (this.vatMaterial) {
        // In overlay mode the VAT result is drawn as a wireframe cage on top of
        // the skeletal mesh, so any mismatch shows up immediately.
        const overlay = this.mode === 'both';
        this.vatMaterial.wireframe = overlay;
        (this.vatMaterial.uniforms.vatColor.value as THREE.Color).set(
          overlay ? 0x4ade9b : 0x9fb4c7,
        );
        this.vatMaterial.depthTest = !overlay;
      }
    }
  }

  /** Point the VAT preview at a (possibly fractional) global frame. */
  setVATFrame(globalFrame: number, totalFrames: number, interpolate: boolean): void {
    if (!this.vatMaterial) return;
    const max = Math.max(0, totalFrames - 1);
    const clamped = Math.max(0, Math.min(globalFrame, max));
    const lo = Math.floor(clamped);
    const hi = Math.min(lo + 1, max);
    this.vatMaterial.uniforms.vatFrameLo.value = lo;
    this.vatMaterial.uniforms.vatFrameHi.value = interpolate ? hi : lo;
    this.vatMaterial.uniforms.vatFrameBlend.value = interpolate ? clamped - lo : 0;
  }

  dispose(): void {
    this.unmount();
    this.disposeVAT();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

export const viewport = new Viewport();
