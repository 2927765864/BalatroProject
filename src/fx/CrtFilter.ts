/**
 * Full-screen CRT post-process Filter (PixiJS v8).
 *
 * Algorithm (rewrite, not a GPL file copy):
 *   - Scanline weight + highlight mix inspired by CRT-Easymode
 *     https://github.com/libretro/glsl-shaders/blob/master/crt/shaders/crt-easymode.glsl
 *   - Luminance-preservation intent:
 *     https://godotshaders.com/shader/crt-with-luminance-preservation/
 *   - Product posture: single-pass web CRT vibe
 *     https://github.com/gingerbeardman/webgl-crt-shader
 *
 * Integration mirrors BalatroBackgroundFilter:
 *   Filter + GlProgram + GpuProgram (WebGPU skips filters without gpuProgram)
 *   vTextureCoord * system uInputSize (not raw gl_FragCoord)
 *
 * Mount on stage so BackgroundView (stage-space) and worldRoot share one pass.
 */

import {
  Filter,
  GlProgram,
  GpuProgram,
  UniformGroup,
} from "pixi.js";

/** Default Pixi v8 filter vertex (same as BalatroBackgroundFilter / defaults). */
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
 * Fragment: Easymode-style cos scanlines + scan_bright mix; optional shadow noise.
 * System uniforms (uInputSize, uTexture) come from Pixi filter pipeline.
 */
const FILTER_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;

uniform float uIntensity;
uniform float uScanlineCount;
uniform float uNoiseAmount;
uniform float uContrast;
uniform float uNoiseSeed;

const float PI = 3.141592653589793;
const float SCAN_BEAM = 1.5;
const float SCAN_BRIGHT_MIN = 0.35;
const float SCAN_BRIGHT_MAX = 0.65;

// Public-domain-style hash (IQ / common GLSL idiom); not a proprietary noise model.
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec4 tex = texture(uTexture, vTextureCoord);
    vec3 col = tex.rgb;

    // Weak pre-contrast (T1)
    col = (col - 0.5) * uContrast + 0.5;

    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float bright = (max(col.r, max(col.g, col.b)) + luma) * 0.5;
    float scan_bright = clamp(bright, SCAN_BRIGHT_MIN, SCAN_BRIGHT_MAX);

    // Design-resolution line count (R2), not physical pixel rows
    float scan_weight = 1.0
        - pow(cos(vTextureCoord.y * 2.0 * PI * uScanlineCount) * 0.5 + 0.5, SCAN_BEAM)
            * uIntensity;

    vec3 col2 = col;
    col *= scan_weight;
    col = mix(col, col2, scan_bright);

    // Shadow-weighted grain (N3)
    if (uNoiseAmount > 0.0001) {
        float n = hash12(vTextureCoord * uInputSize.xy + vec2(uNoiseSeed, uNoiseSeed)) * 2.0 - 1.0;
        float dark = 1.0 - clamp(luma, 0.0, 1.0);
        col += n * uNoiseAmount * dark;
    }

    finalColor = vec4(clamp(col, 0.0, 1.0), tex.a);
}
`;

const FILTER_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

// 5 f32 = 20 bytes; pad to 32-byte struct for safe UBO alignment.
struct CrtUniforms {
  uIntensity: f32,
  uScanlineCount: f32,
  uNoiseAmount: f32,
  uContrast: f32,
  uNoiseSeed: f32,
  uPad0: f32,
  uPad1: f32,
  uPad2: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> crtUniforms: CrtUniforms;

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

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {
  let tex = textureSample(uTexture, uSampler, uv);
  var col = tex.rgb;

  let uIntensity = crtUniforms.uIntensity;
  let uScanlineCount = crtUniforms.uScanlineCount;
  let uNoiseAmount = crtUniforms.uNoiseAmount;
  let uContrast = crtUniforms.uContrast;
  let uNoiseSeed = crtUniforms.uNoiseSeed;

  col = (col - 0.5) * uContrast + 0.5;

  let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  let bright = (max(col.r, max(col.g, col.b)) + luma) * 0.5;
  let scan_bright = clamp(bright, 0.35, 0.65);

  let PI = 3.141592653589793;
  let SCAN_BEAM = 1.5;
  let cosTerm = cos(uv.y * 2.0 * PI * uScanlineCount) * 0.5 + 0.5;
  let scan_weight = 1.0 - pow(cosTerm, SCAN_BEAM) * uIntensity;

  let col2 = col;
  col = col * scan_weight;
  col = mix(col, col2, scan_bright);

  if (uNoiseAmount > 0.0001) {
    let n = hash12(uv * gfu.uInputSize.xy + vec2<f32>(uNoiseSeed, uNoiseSeed)) * 2.0 - 1.0;
    let dark = 1.0 - clamp(luma, 0.0, 1.0);
    col = col + n * uNoiseAmount * dark;
  }

  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), tex.a);
}
`;

export type CrtUniformValues = {
  intensity: number;
  scanlineCount: number;
  noiseAmount: number;
  contrast: number;
  noiseSeed: number;
};

export class CrtFilter extends Filter {
  private readonly crtUniforms: UniformGroup;

  constructor() {
    const crtUniforms = new UniformGroup({
      uIntensity: { value: 0.35, type: "f32" },
      uScanlineCount: { value: 720, type: "f32" },
      uNoiseAmount: { value: 0.02, type: "f32" },
      uContrast: { value: 1.05, type: "f32" },
      uNoiseSeed: { value: 0, type: "f32" },
      // std140 / WGSL pad to match CrtUniforms (8 × f32)
      uPad0: { value: 0, type: "f32" },
      uPad1: { value: 0, type: "f32" },
      uPad2: { value: 0, type: "f32" },
    });

    const glProgram = GlProgram.from({
      vertex: FILTER_VERT,
      fragment: FILTER_FRAG,
      name: "crt-filter",
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
        crtUniforms,
      },
      padding: 0,
      antialias: false,
    });

    this.crtUniforms = crtUniforms;
  }

  applyUniforms(v: CrtUniformValues): void {
    const u = this.crtUniforms.uniforms as Record<string, unknown>;
    u["uIntensity"] = v.intensity;
    u["uScanlineCount"] = v.scanlineCount;
    u["uNoiseAmount"] = v.noiseAmount;
    u["uContrast"] = v.contrast;
    u["uNoiseSeed"] = v.noiseSeed;
  }
}
