/**
 * Balatro-style paint-mix full-screen background Filter (PixiJS v8).
 *
 * Algorithm sources (community reimplementations, not game package shaders):
 *   - GLSL logic: https://github.com/Azkun/balatroShader/blob/main/balatroShader.js (fragSrc)
 *   - lighting term: https://github.com/Hammster/windows-terminal-shaders/blob/main/balatro.hlsl (effect())
 *   - lineage: https://www.shadertoy.com/view/XXtBRr
 *
 * Pixi integration:
 *   - Filter + GlProgram + GpuProgram (required for WebGPU; without gpuProgram filter is skipped)
 *   - Official Filter vertex / WGSL group layout mirrors pixi NoiseFilter
 *   - Docs: https://pixijs.com/8.x/guides/components/filters
 *
 * Coordinate note: use vTextureCoord * uInputSize.xy (not raw gl_FragCoord) so the
 * pattern is stable inside the filter render target.
 * Output is pure background (no hlsl terminal (bg/3)+fg composite).
 */

import {
  Filter,
  GlProgram,
  GpuProgram,
  UniformGroup,
} from "pixi.js";

/** Default Pixi v8 filter vertex (same as filters/defaults/defaultFilter.vert). */
const FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

/**
 * Fragment: Azkun fragSrc math + optional lighting from balatro.hlsl effect().
 * System filter uniforms (uInputSize, uTexture) come from Pixi filter pipeline.
 */
const FILTER_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;

uniform float uTime;
uniform float uSpinTime;
uniform float uContrast;
uniform float uSpinAmount;
uniform float uPixelFac;
uniform float uSpinEase;
uniform float uZoom;
uniform vec2 uOffset;
uniform vec4 uColour1;
uniform vec4 uColour2;
uniform vec4 uColour3;
uniform float uLighting;

void main() {
    // Placeholders: keep uTexture referenced so the filter pipeline binds it.
    vec4 _discardSample = texture(uTexture, vTextureCoord);
    _discardSample *= 0.0;

    // Screen coords in filter RT (Azkun used gl_FragCoord; Filter needs this form).
    vec2 screen_coords = vTextureCoord * uInputSize.xy;
    vec2 resolution = uInputSize.xy;

    // Azkun: length(resolution.xy) / pixel_fac
    float pixel_size = length(resolution) / max(uPixelFac, 1.0);

    vec2 uv = (floor(screen_coords / pixel_size) * pixel_size - 0.5 * resolution)
        / length(resolution) - uOffset;
    float uv_len = length(uv);

    float speed = (uSpinTime * uSpinEase * 0.2) + 302.2;
    float angle = atan(uv.y, uv.x)
        + (uSpinAmount > 0.0
            ? speed - uSpinEase * 20.0 * (uSpinAmount * uv_len + (1.0 - uSpinAmount))
            : 0.0);

    vec2 mid = (resolution / length(resolution)) / 2.0;
    uv = vec2(uv_len * cos(angle) + mid.x, uv_len * sin(angle) + mid.y) - mid;

    // Azkun zoom default 30: uv *= zoom
    uv *= uZoom;
    speed = uTime * 2.0;

    vec2 uv2 = vec2(uv.x + uv.y);

    // Fixed 5 iterations — do not change (Azkun / hlsl).
    for (int i = 0; i < 5; i++) {
        uv2 += sin(max(uv.x, uv.y)) + uv;
        uv += 0.5 * vec2(
            cos(5.1123314 + 0.353 * uv2.y + speed * 0.131121),
            sin(uv2.x - 0.113 * speed)
        );
        uv -= 1.0 * cos(uv.x + uv.y) - 1.0 * sin(uv.x * 0.711 - uv.y);
    }

    float cmod = (0.25 * uContrast + 0.5 * uSpinAmount + 1.2);
    float paint = min(2.0, max(0.0, length(uv) * 0.035 * cmod));
    float c1p = max(0.0, 1.0 - cmod * abs(1.0 - paint));
    float c2p = max(0.0, 1.0 - cmod * abs(paint));
    float c3p = 1.0 - min(1.0, c1p + c2p);

    // Azkun ret (no /3, no fg blend)
    vec4 ret = (0.3 / max(uContrast, 0.001)) * uColour1
        + (1.0 - 0.3 / max(uContrast, 0.001))
            * (uColour1 * c1p + uColour2 * c2p + vec4(c3p * uColour3.rgb, c3p * uColour1.a));

    // hlsl lighting (LIGTHING), low by default for felt readability
    float light = (uLighting - 0.2) * max(c1p * 5.0 - 4.0, 0.0)
        + uLighting * max(c2p * 5.0 - 4.0, 0.0);
    ret.rgb += light;

    finalColor = vec4(ret.rgb, 1.0) + _discardSample;
}
`;

/** WGSL dual-backend program (group layout matches Pixi NoiseFilter). */
const FILTER_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

// Layout matches UniformGroup std140-style packing (vec4 after vec2 needs 8-byte pad).
struct BgUniforms {
  uTime: f32,
  uSpinTime: f32,
  uContrast: f32,
  uSpinAmount: f32,
  uPixelFac: f32,
  uSpinEase: f32,
  uZoom: f32,
  uLighting: f32,
  uOffset: vec2<f32>,
  uPadOffset: vec2<f32>,
  uColour1: vec4<f32>,
  uColour2: vec4<f32>,
  uColour3: vec4<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> bgUniforms: BgUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(
    filterVertexPosition(aPosition),
    filterTextureCoord(aPosition)
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
  let _discardSample = textureSample(uTexture, uSampler, uv) * 0.0;

  let resolution = gfu.uInputSize.xy;
  let screen_coords = uv * resolution;

  let pixel_size = length(resolution) / max(bgUniforms.uPixelFac, 1.0);
  var uvw = (floor(screen_coords / pixel_size) * pixel_size - 0.5 * resolution)
    / length(resolution) - bgUniforms.uOffset;
  let uv_len = length(uvw);

  var speed = (bgUniforms.uSpinTime * bgUniforms.uSpinEase * 0.2) + 302.2;
  var angle = atan2(uvw.y, uvw.x);
  if (bgUniforms.uSpinAmount > 0.0) {
    angle = angle + speed - bgUniforms.uSpinEase * 20.0
      * (bgUniforms.uSpinAmount * uv_len + (1.0 - bgUniforms.uSpinAmount));
  }

  let mid = (resolution / length(resolution)) / 2.0;
  uvw = vec2(uv_len * cos(angle) + mid.x, uv_len * sin(angle) + mid.y) - mid;
  uvw = uvw * bgUniforms.uZoom;
  speed = bgUniforms.uTime * 2.0;

  var uv2 = vec2(uvw.x + uvw.y, uvw.x + uvw.y);

  for (var i = 0; i < 5; i = i + 1) {
    uv2 = uv2 + sin(max(uvw.x, uvw.y)) + uvw;
    uvw = uvw + 0.5 * vec2(
      cos(5.1123314 + 0.353 * uv2.y + speed * 0.131121),
      sin(uvw.x - 0.113 * speed)
    );
    uvw = uvw - (1.0 * cos(uvw.x + uvw.y) - 1.0 * sin(uvw.x * 0.711 - uvw.y));
  }

  let cmod = (0.25 * bgUniforms.uContrast + 0.5 * bgUniforms.uSpinAmount + 1.2);
  let paint = min(2.0, max(0.0, length(uvw) * 0.035 * cmod));
  let c1p = max(0.0, 1.0 - cmod * abs(1.0 - paint));
  let c2p = max(0.0, 1.0 - cmod * abs(paint));
  let c3p = 1.0 - min(1.0, c1p + c2p);

  let invC = 0.3 / max(bgUniforms.uContrast, 0.001);
  var ret = invC * bgUniforms.uColour1
    + (1.0 - invC) * (
      bgUniforms.uColour1 * c1p
      + bgUniforms.uColour2 * c2p
      + vec4(c3p * bgUniforms.uColour3.rgb, c3p * bgUniforms.uColour1.a)
    );

  let light = (bgUniforms.uLighting - 0.2) * max(c1p * 5.0 - 4.0, 0.0)
    + bgUniforms.uLighting * max(c2p * 5.0 - 4.0, 0.0);
  ret = vec4(ret.rgb + light, 1.0);

  return ret + _discardSample;
}
`;

export type BalatroBgUniformValues = {
  uTime: number;
  uSpinTime: number;
  uContrast: number;
  uSpinAmount: number;
  uPixelFac: number;
  uSpinEase: number;
  uZoom: number;
  uLighting: number;
  offsetX: number;
  offsetY: number;
  colour1: [number, number, number, number];
  colour2: [number, number, number, number];
  colour3: [number, number, number, number];
};

export class BalatroBackgroundFilter extends Filter {
  private readonly bgUniforms: UniformGroup;

  constructor() {
    const bgUniforms = new UniformGroup({
      uTime: { value: 0, type: "f32" },
      uSpinTime: { value: 0, type: "f32" },
      uContrast: { value: 1.4, type: "f32" },
      uSpinAmount: { value: 0.3, type: "f32" },
      uPixelFac: { value: 900, type: "f32" },
      uSpinEase: { value: 0.5, type: "f32" },
      uZoom: { value: 30, type: "f32" },
      uLighting: { value: 0.25, type: "f32" },
      uOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
      // std140: pad to 16-byte boundary before vec4 colours (WebGPU UBO)
      uPadOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
      uColour1: { value: new Float32Array([0.35, 0.69, 0.48, 1]), type: "vec4<f32>" },
      uColour2: { value: new Float32Array([0.29, 0.55, 0.4, 1]), type: "vec4<f32>" },
      uColour3: { value: new Float32Array([0.1, 0.24, 0.18, 1]), type: "vec4<f32>" },
    });

    const glProgram = GlProgram.from({
      vertex: FILTER_VERT,
      fragment: FILTER_FRAG,
      name: "balatro-background-filter",
    });

    const gpuProgram = GpuProgram.from({
      vertex: {
        source: FILTER_WGSL,
        entryPoint: "mainVertex",
      },
      fragment: {
        source: FILTER_WGSL,
        entryPoint: "mainFragment",
      },
    });

    super({
      glProgram,
      gpuProgram,
      resources: {
        bgUniforms,
      },
      padding: 0,
      antialias: false,
    });

    this.bgUniforms = bgUniforms;
  }

  applyUniforms(v: BalatroBgUniformValues): void {
    const u = this.bgUniforms.uniforms as Record<string, unknown>;
    u["uTime"] = v.uTime;
    u["uSpinTime"] = v.uSpinTime;
    u["uContrast"] = v.uContrast;
    u["uSpinAmount"] = v.uSpinAmount;
    u["uPixelFac"] = v.uPixelFac;
    u["uSpinEase"] = v.uSpinEase;
    u["uZoom"] = v.uZoom;
    u["uLighting"] = v.uLighting;
    // Reassign arrays so UniformGroup marks dirty / uploads (in-place edit can stick).
    u["uOffset"] = new Float32Array([v.offsetX, v.offsetY]);
    u["uColour1"] = new Float32Array(v.colour1);
    u["uColour2"] = new Float32Array(v.colour2);
    u["uColour3"] = new Float32Array(v.colour3);
  }
}

/** Convert 0xRRGGBB to premultiplied-ready RGBA 0–1. */
export function hexColorToRgba(hex: number): [number, number, number, number] {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return [r, g, b, 1];
}
