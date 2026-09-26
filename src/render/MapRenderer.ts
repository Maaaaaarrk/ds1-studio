import type { Palette } from '../formats/palette';
import { ATLAS_SIZE, type TileAtlas } from './atlas';

export interface Camera {
  x: number; // world point at the viewport centre
  y: number;
  zoom: number; // device pixels per world pixel
}

export const enum InstanceFlag {
  Shadow = 1,
  Highlight = 2,
  Dim = 4,
  Ghost = 8,
}

export interface Instance {
  x: number;
  y: number;
  w: number;
  h: number;
  u: number;
  v: number;
  layer: number;
  flags: number;
}

const FLOATS_PER_INSTANCE = 8;

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aDst;   // world x, y, w, h
layout(location=2) in vec2 aSrc;   // atlas texel u, v
layout(location=3) in vec2 aMeta;  // layer, flags
uniform vec2 uViewport;            // device pixels
uniform vec3 uCamera;              // x, y, zoom
out vec2 vTex;
flat out float vLayer;
flat out int vFlags;
void main() {
  vec2 world = aDst.xy + aCorner * aDst.zw;
  vec2 screen = (world - uCamera.xy) * uCamera.z + uViewport * 0.5;
  gl_Position = vec4(screen / uViewport * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vTex = aSrc + aCorner * aDst.zw;
  vLayer = aMeta.x;
  vFlags = int(aMeta.y);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform sampler2D uPalette;
in vec2 vTex;
flat in float vLayer;
flat in int vFlags;
out vec4 outColor;
void main() {
  float idx = texelFetch(uAtlas, ivec3(ivec2(floor(vTex)), int(vLayer)), 0).r * 255.0;
  int i = int(idx + 0.5);
  if (i == 0) discard;
  if ((vFlags & 1) != 0) { outColor = vec4(0.0, 0.0, 0.0, 0.45); return; }
  vec4 c = texelFetch(uPalette, ivec2(i, 0), 0);
  if ((vFlags & 2) != 0) c.rgb = mix(c.rgb, vec3(1.0, 0.78, 0.3), 0.35);
  if ((vFlags & 4) != 0) c.rgb *= 0.35;
  outColor = vec4(c.rgb, (vFlags & 8) != 0 ? 0.6 : 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

/** Draws tile instances from a TileAtlas with WebGL2 in a single instanced call. */
export class MapRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly atlasTex: WebGLTexture;
  private readonly paletteTex: WebGLTexture;
  private readonly uViewport: WebGLUniformLocation;
  private readonly uCamera: WebGLUniformLocation;
  private instanceCount = 0;
  private atlasLayers = 0;
  private uploadedPages = 0;
  private uploadedAtlas: TileAtlas | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.program = p;
    this.uViewport = gl.getUniformLocation(p, 'uViewport')!;
    this.uCamera = gl.getUniformLocation(p, 'uCamera')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_INSTANCE * 4;
    const attrs: [number, number, number][] = [
      [1, 4, 0],
      [2, 2, 16],
      [3, 2, 24],
    ];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!;
    this.paletteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    for (const t of [gl.TEXTURE_2D]) {
      gl.texParameteri(t, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(t, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
  }

  setPalette(palette: Palette): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette);
  }

  /** Uploads atlas pages; call after adding tiles to the atlas. Re-allocates the texture array when it grows. */
  syncAtlas(atlas: TileAtlas): void {
    const gl = this.gl;
    const n = atlas.pages.length;
    if (n === 0) return;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // A new atlas (another map was opened) must be uploaded from scratch: its pages reuse the texture layers. Otherwise
    // resume at the last page uploaded, which may have gained tiles since (only the newest page is ever appended to).
    let from = this.uploadedAtlas === atlas ? Math.max(0, this.uploadedPages - 1) : 0;
    this.uploadedAtlas = atlas;
    if (n > this.atlasLayers) {
      this.atlasLayers = Math.max(n, this.atlasLayers * 2, 2);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, ATLAS_SIZE, ATLAS_SIZE, this.atlasLayers, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      from = 0;
    }
    for (let i = from; i < n; i++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, ATLAS_SIZE, ATLAS_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, atlas.pages[i]);
    }
    this.uploadedPages = n;
  }

  setInstances(instances: Instance[]): void {
    const data = new Float32Array(instances.length * FLOATS_PER_INSTANCE);
    instances.forEach((it, i) => {
      data.set([it.x, it.y, it.w, it.h, it.u, it.v, it.layer, it.flags], i * FLOATS_PER_INSTANCE);
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.instanceCount = instances.length;
  }

  draw(camera: Camera, background: [number, number, number]): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.instanceCount === 0 || this.atlasLayers === 0) return;

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.uViewport, width, height);
    // Snap the camera to whole device pixels so tiles don't shimmer while panning.
    const snap = (v: number) => Math.round(v * camera.zoom) / camera.zoom;
    gl.uniform3f(this.uCamera, snap(camera.x), snap(camera.y), camera.zoom);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uAtlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uPalette'), 1);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);
    gl.bindVertexArray(null);
  }
}
