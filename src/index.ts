// 2x canvas for auto smoothing?
// matrix transform for scale transforms

import * as Regl from "regl"

const WHITE: [number, number, number, number] = [ 1, 1, 1, 1 ]
const devicePixelRatio = window.devicePixelRatio || 1;
const canvas = document.createElement('canvas');
canvas.width = 1200 * devicePixelRatio;
canvas.height = 800 * devicePixelRatio;

canvas.style.width = (canvas.width / devicePixelRatio) + 'px';
canvas.style.height = (canvas.height / devicePixelRatio) + 'px';

document.body.appendChild(canvas);

const regl = Regl({
  canvas: canvas,
  extensions: ['angle_instanced_arrays', 'OES_standard_derivatives'],
  attributes: {antialias: true}},
)

const N = 1000

// Simulate a Bokeh ColumnDataSource
const source = {
  data: {
    x: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    y: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    size: Float32Array.from(Array(N).fill(0).map((_, i) => { return Math.random() * 51.05 + 61.02 })),
    angle: Float32Array.from(Array(N).fill(0).map((_, i) => { return Math.random() * 2*Math.PI })),
    fill_color: Array(N).fill(0).map((_, i) => { return [Math.random(), Math.random(), 0.5] }),
    line_color: Array(N).fill(0).map((_, i) => { return [0.8, Math.random(), Math.random()] }),
    line_width: Array(N).fill(0).map((_, i) => { return Math.random()*5 + 1}),
  }
}

// Simulate a Bokeh Glyph with scalar/vector attributes
const glyph = {
  x: {field: "x"},
  y: {field: "y"},
  // y: {value: 0},
  size: {field: "size"},
  // size: {value: 30},
  angle: {value: 0},
  //angle: {field: "angle"},
  fill_color: {field: "fill_color"},
  fill_alpha: {value: 0.3},
  //line_color: {value: [0.0, 0.0, 0.0]},
  line_color: {field: "fill_color"},
  line_alpha: {value: 1.0},
  line_width: {value: 16.0},
  //line_width: {field: "line_width"},
}

function declare_attribute(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `attribute ${typ} ${name};`
}

function declare_uniform(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `uniform ${typ} ${name};`
}

function declare(name: string, marker: any): string {
  if (marker[name].value !== undefined)
    return declare_uniform(name)
  else
    return declare_attribute(name)
}

function declarations(marker: any): string {
  return `
  ${declare("x", marker)}
  ${declare("y", marker)}
  ${declare("size", marker)}
  ${declare("angle", marker)}
  ${declare("fill_color", marker)}
  ${declare("fill_alpha", marker)}
  ${declare("line_color", marker)}
  ${declare("line_alpha", marker)}
  ${declare("line_width", marker)}
  `
}

const MARKER_PROPERTIES: string[] = [
  "x", "y", "size", "angle", "fill_color", "fill_alpha", "line_color", "line_alpha", "line_width"
]

function make_uniforms(marker: any, source: any): any {
  const result = {
    canvas_width: regl.context('viewportWidth'),
    canvas_height: regl.context('viewportHeight'),
  }
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].value !== undefined)
      result[prop] = marker[prop].value
  }
  return result
}

function make_attributes(marker: any, source: any, position: number[][]): any {
  const result = {position: position}
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].field !== undefined) {
      const data = source.data[marker[prop].field]
      const buffer =  regl.buffer({data: data, usage: "dynamic"})
      result[prop] = {buffer: buffer, divisor: 1}
    }
  }
  return result
}

abstract class MarkerProgram {
  static primitive: string = "points"
  static count: number

  marker: any
  source: any

  constructor(marker: any, source: any) {
    this.marker = marker
    this.source = source
  }

  abstract distance(): string

  vert_shader(marker: any): string {
    return `
    precision mediump float;
    attribute vec2 position;

    ${declarations(marker)}

    varying float v_angle;
    varying float v_size;
    varying vec3 v_fill_color;
    varying float v_fill_alpha;
    varying vec3 v_line_color;
    varying float v_line_alpha;
    varying float v_line_width;

    void main() {
      gl_PointSize = size;
      gl_Position = vec4(position.x * size + x, position.y * size + y, 0, 1);
      v_size = size;
      v_angle = angle;
      v_fill_color = fill_color;
      v_fill_alpha = fill_alpha;
      v_line_color = line_color;
      v_line_alpha = line_alpha;
      v_line_width = line_width;
    }
    `
  }

  frag_shader(marker: any): string {
    return `
    precision mediump float;

    const float SQRT_2 = 1.4142135623730951;
    const float PI = 3.14159265358979323846264;

    varying float v_size;
    varying float v_angle;
    varying vec3 v_fill_color;
    varying float v_fill_alpha;
    varying vec3 v_line_color;
    varying float v_line_alpha;
    varying float v_line_width;

    vec4 outline(float distance, float antialias, vec4 fill_color, vec4 line_color, float line_width) {
      vec4 frag_color;

      float t = line_width/2.0 - antialias;
      float signed_distance = distance;
      float border_distance = abs(signed_distance) - t;
      float alpha = border_distance/antialias;
      alpha = exp(-alpha*alpha);

      // If line alpha is zero, it means no outline. To avoid a dark outline shining
      // through due to AA, we set the line color to the fill color and avoid branching.
      float select = float(bool(line_color.a));
      line_color.rgb = select * line_color.rgb + (1.0  - select) * fill_color.rgb;

      // Similarly, if we want a transparent fill
      select = float(bool(fill_color.a));
      fill_color.rgb = select * fill_color.rgb + (1.0  - select) * line_color.rgb;

      if (border_distance < 0.0)
          frag_color = line_color;
      else if (signed_distance < 0.0) {
          frag_color = mix(fill_color, line_color, sqrt(alpha));
      } else {
          if (abs(signed_distance) < (line_width/2.0 + antialias) ) {
              frag_color = vec4(line_color.rgb, line_color.a * alpha);
          } else {
            frag_color = vec4(line_color.rgb, 0.0);
          }
      }

      return frag_color;
    }

    ${this.main()}
    `
  }

  main(): string {
    return `
    void main () {
      vec4 fill_color = vec4(v_fill_color, v_fill_alpha);
      vec4 line_color = vec4(v_line_color, v_line_alpha);

      vec2 P = 2.0 * gl_PointCoord - 1.0;
      P = vec2(
         cos(v_angle) * P.x + sin(v_angle) * P.y,
        -sin(v_angle) * P.x + cos(v_angle) * P.y
      );

      float point_size = v_size + 2.0 * (v_line_width + 1.5);
      P *= point_size;

      ${this.distance()}

      gl_FragColor = outline(distance, 0.8, fill_color, line_color, v_line_width);
    }
    `
  }

  public generate(): Regl.DrawCommand {
    console.log(this.vert_shader(this.marker))
    console.log(this.frag_shader(this.marker))
    console.log(make_uniforms(this.marker, this.source))
    return regl({
      frag: this.frag_shader(this.marker),
      vert: this.vert_shader(this.marker),
      attributes: make_attributes(this.marker, this.source, this.position),
      uniforms: make_uniforms(this.marker, this.source),
      count: this.count,
      instances: N,
      primitive: this.primitive as any,  // type?
      depth: { enable: false },
      blend: {
        enable: true,
        func: { srcRGB: 'src alpha', srcAlpha: 1, dstRGB: 'one minus src alpha', dstAlpha: 1 },
        equation: { rgb: 'add', alpha: 'add' },
        color: [0, 0, 0, 0]
      },
    })
  }

  get position(): number[][] {
    return [[0.0, 0.0]]
  }

  get primitive(): string {
    return "points"
  }

  get count(): number {
    return 1
  }

}

class CircleProgram extends MarkerProgram {
  distance(): string {
    return `float distance = length(P) - v_size/2.0;`
  }
}

class SquareProgram extends MarkerProgram {
  distance(): string {
    return `float distance = max(abs(P.x), abs(P.y)) - v_size/2.0;`
  }
}

class DiamondProgram extends MarkerProgram {
  distance(): string {
    return `
    float x = SQRT_2 / 2.0 * (P.x * 1.5 - P.y);
    float y = SQRT_2 / 2.0 * (P.x * 1.5 + P.y);
    float r1 = max(abs(x), abs(y)) - v_size / (2.0 * SQRT_2);
    float distance = r1 / SQRT_2;
    `
  }
}

class TriangleProgram extends MarkerProgram {
  distance(): string {
    return `
    P.y -= v_size * 0.3;
    float x = SQRT_2 / 2.0 * (P.x * 1.7 - P.y);
    float y = SQRT_2 / 2.0 * (P.x * 1.7 + P.y);
    float r1 = max(abs(x), abs(y)) - v_size / 1.6;
    float r2 = P.y;
    float distance = max(r1 / SQRT_2, r2);  // Intersect diamond with rectangle
    `
  }
}

class XProgram extends MarkerProgram {
  distance(): string {
    return `
    float circle = length(P) - v_size / 1.6;
    float X = min(abs(P.x - P.y), abs(P.x + P.y)) - v_size / 100.0;  // bit of "width" for aa
    float distance = max(circle, X);
    `
  }
}


const program = new XProgram(glyph, source)

const command = program.generate()

function update() {
  regl.clear({ color: WHITE })
  command(canvas)
}

update()
//regl.frame(update)